/**
 * Facebook Firefox Toolbar Software License
 * Copyright (c) 2007 Facebook, Inc.
 *
 * Permission is hereby granted, free of charge, to any person or organization
 * obtaining a copy of the software and accompanying documentation covered by
 * this license (which, together with any graphical images included with such
 * software, are collectively referred to below as the "Software") to (a) use,
 * reproduce, display, distribute, execute, and transmit the Software, (b)
 * prepare derivative works of the Software (excluding any graphical images
 * included with the Software, which may not be modified or altered), and (c)
 * permit third-parties to whom the Software is furnished to do so, all
 * subject to the following:
 *
 * The copyright notices in the Software and this entire statement, including
 * the above license grant, this restriction and the following disclaimer,
 * must be included in all copies of the Software, in whole or in part, and
 * all derivative works of the Software, unless such copies or derivative
 * works are solely in the form of machine-executable object code generated by
 * a source language processor.
 *
 * Facebook, Inc. retains ownership of the Software and all associated
 * intellectual property rights.  All rights not expressly granted in this
 * license are reserved by Facebook, Inc.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE, TITLE AND NON-INFRINGEMENT. IN NO EVENT
 * SHALL THE COPYRIGHT HOLDERS OR ANYONE DISTRIBUTING THE SOFTWARE BE LIABLE
 * FOR ANY DAMAGES OR OTHER LIABILITY, WHETHER IN CONTRACT, TORT OR OTHERWISE,
 * ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */

const BASE_CHECK_INTERVAL = 5*60*1000; // 5 minutes
const DEBUG     = false;
const VERBOSITY = 0; // 0: no dumping, 1: normal dumping, 2: massive dumping

var debug = ( VERBOSITY < 1 )
  ? function() {}
  : function() {
  dump('FacebookService: ');
  if (debug.caller && debug.caller.name)
    dump(debug.caller.name + ': ')
  for( var i=0; i < arguments.length; i++ ) {
    if( i ) dump( ', ' );
    switch( typeof arguments[i] ) {
      case 'xml':
        dump( arguments[i].toXMLString() );
        break;s
      case 'object':
        dump( '[obj]\n' );
        for( prop in arguments[i] )
          dump( ' ' + prop + ': ' + arguments[i][prop] + '\n' );
        dump( '[/obj]\n' );
        break;
      default:
        dump( arguments[i] );
    }
  }
  dump('\n');
}
var vdebug = ( VERBOSITY < 2 ) ? function() {} : debug;

const CONTRACT_ID  = '@facebook.com/facebook-service;1';
const CLASS_ID     = Components.ID('{e983db0e-05fc-46e7-9fba-a22041c894ac}');
const CLASS_NAME   = 'Facebook API Connector';

var Cc = Components.classes;
var Ci = Components.interfaces;

// Load MD5 code...
Cc['@mozilla.org/moz/jssubscript-loader;1']
    .getService(Ci.mozIJSSubScriptLoader)
    .loadSubScript('chrome://facebook/content/md5.js');

/** class SetNotif:
 * Encapsulates notifs for a set of ids delivered as an xml list.
 * Watcher for "size" property notifies the observer when the size value
 * changes.
 */
function SetNotif( asXmlList, topic, dispatcher, on_new_item ) {
    this.topic = topic;
    this.dispatcher  = dispatcher;
    this.on_new_item = on_new_item;
    this.watch( "size", function( prop, oldVal, newVal ) {
        if( oldVal != newVal )
            dispatcher.notify( null, topic, newVal );
        return newVal;
    });
    this.init( asXmlList );
}
SetNotif.prototype.__defineGetter__( "count", function() {
  debug( this.topic, "count accessed", this.size );
  return this.size;
});
SetNotif.prototype.update = function( asXmlList ) {
    debug( "SetNotif.update", this.topic, asXmlList.toXMLString() );
    var itemSet = {};
    var diff  = [];
    this.size = asXmlList.length();
    for( var i=0; i<this.size; i++ ){
        it = Number(asXmlList[i]);
        itemSet[it] = true;
        if( !this.items[it] )
            diff.push(it);
    }
    if( diff.length > 0 && null != this.on_new_item )
        this.on_new_item( this, diff );
    this.items = itemSet;
}
SetNotif.prototype.init = function( asXmlList ) {
    debug( "SetNotif.init", asXmlList.toXMLString() );
    this.size  = asXmlList.length();
    var itemSet = {};
    if( this.size > 0 )
        for each( var it in asXmlList )
            itemSet[it.text()] = true;
    this.items = itemSet;
}

/* class CountedNotif:
   Encapsulates notifs for which an xml object
   containing an unread and most recent element is present.
*/
function CountedNotif( asXml, topic, dispatcher, on_new_unread ) {
    this.topic = topic;
    this.on_new_unread = on_new_unread;
    this.dispatcher = dispatcher;
    this.time  = Number(asXml.most_recent);
    this.count = Number(asXml.unread);
}
CountedNotif.prototype.__defineSetter__( "count", function( count ) {
  debug( this.topic, 'setCount', count );
  this.dispatcher.notify(null, this.topic, count);
  this._count = count;
});
CountedNotif.prototype.__defineGetter__( "count", function() {
  debug( this.topic, "count accessed", this._count );
  return this._count;
});
CountedNotif.prototype.setTime = function( new_time ) {
    debug( this.topic, 'setTime', this.time, new_time );
    if( ('function' == typeof this.on_new_unread)
        && (new_time > this.time)
        && (this.count > 0) ) {
        this.on_new_unread( this.count );
    }
    if( new_time != this.time )
        this.time = new_time;
};
CountedNotif.prototype.update = function(asXml) {
    this.count = Number(asXml.unread);
    this.setTime( Number(asXml.most_recent) );
};

var fbSvc; // so that all our callback functions objects can access "this"
function facebookService()
{
    debug('constructor');

    this._apiKey = '8d7be0a45c164647647602a27106cc65';
    this._secret = 'c9646e8dccec4c2726c65f6f5eeca86a';

    this.initValues();

    fbSvc = this;
    if( !DEBUG )
      this._checker = {
        notify: function(timer) {
            var now = Date.now();
            // only do a check if either:
            //   1. we loaded an fb page in the last minute
            if ((fbSvc._lastFBLoad > fbSvc._lastChecked)
            //   2. or we haven't checked in the last 5 minutes and any page has loaded
                || ( fbSvc._lastPageLoad > fbSvc._lastChecked
                    && now > fbSvc._lastChecked + BASE_CHECK_INTERVAL)
            //   3. or we haven't checked in the last 10 minutes and no page has loaded
                || ( now > fbSvc._lastChecked + BASE_CHECK_INTERVAL*2))
            {
              var now = Date.now();
              var interval = now - fbSvc._lastChecked;
              fbSvc._lastChecked = now;
              debug('_checker.notify: checking', now, fbSvc._lastFBLoad, fbSvc._lastPageLoad, fbSvc._lastChecked);
              // note: suppress notifications if we haven't successfully checked for the last 30 minutes
              fbSvc.checkUsers(now > fbSvc._lastCheckedFriends + BASE_CHECK_INTERVAL * 6);
              fbSvc.checkNotifications(false);
              fbSvc.checkAlbums(interval);
            } else {
              debug('_checker.notify: skipping', now, fbSvc._lastFBLoad, fbSvc._lastPageLoad, fbSvc._lastChecked);
            }
        }
      };
    else
      this._checker = {
        notify: function(timer) {
          var now = Date.now();
          var interval = now - fbSvc._lastChecked;
          fbSvc._lastChecked = now;
          debug('_checker.notify: checking', now, fbSvc._lastFBLoad, fbSvc._lastPageLoad, fbSvc._lastChecked);
          // note: suppress notifications if we haven't successfully checked for the last 30 minutes
          fbSvc.checkUsers(now > fbSvc._lastCheckedFriends + BASE_CHECK_INTERVAL * 6);
          fbSvc.checkNotifications(false);
          fbSvc.checkAlbums(interval);
        }
      };
    this._initialize = {
        notify: function(timer) {
            debug('_initialize.notify');
            fbSvc._lastChecked = Date.now();
            fbSvc.checkUsers(true);
            fbSvc.checkNotifications(true);
            fbSvc.checkAlbums(0);
            fbSvc._dailyNotifier.set(timer);
        }
    };
    this._dailyNotifier = {
        // this is our really lame way of making sure that the status update
        // times properly get updated each day (so that "today" becomes
        // "yesterday", etc.).
        set: function(timer) {
            // note that we could use a repeating timer instead of always
            // firing one shot timers, but this is slightly less code since we
            // have to do it this way the first time around anyway, and since
            // this only gets run once a day it seems harmless
            var now = new Date();
            var midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1, 0, 0, 1);
            timer.initWithCallback(this, midnight-now, Ci.nsITimer.TYPE_ONE_SHOT);
        },
        notify: function(timer) {
            debug('_dailyNotifier.notify');
            fbSvc.notify(null, 'facebook-new-day', null);
            this.set(timer);
        }
    };
    this._alertObserver = {
        observe: function(subject, topic, data) {
            debug('observed', subject, topic, data);
            if (topic == 'alertclickcallback') {
                debug('opening alert url', data);
                var win = fbSvc._winService.getMostRecentWindow( "navigator:browser" );
                var browser = win ? win.getBrowser() : null;
                if( browser
                  && 2 != fbSvc._prefService.getIntPref('browser.link.open_newwindow') )
                  // 1 => current Firefox window;
                  // 2 => new window;
                  // 3 => a new tab in the current window;
                { // open in a focused tab
                  var tab = browser.addTab( data );
                  browser.selectedTab = tab;
                  win.content.focus();
                }
                else {
                  win = Cc["@mozilla.org/appshell/appShellService;1"].getService(Ci.nsIAppShellService).hiddenDOMWindow;
                  win.open( data );
                }
            }
        }
    };
    this._numAlertsObj = { value: 0 };

    this._winService      = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);
    this._observerService = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);
    this._prefService     = Cc['@mozilla.org/preferences-service;1'].getService(Ci.nsIPrefBranch2);
}

facebookService.prototype = {
    // nsISupports implementation
    QueryInterface: function (iid) {
        if (!iid.equals(Ci.fbIFacebookService) &&
            !iid.equals(Ci.nsISupports))
            throw Components.results.NS_ERROR_NO_INTERFACE;
        return this;
    },

    // ----------- Start Notifications -----------------//
    get numMsgs()       { return this._messages.count; },
    get numPokes()      { return this._pokes.count; },
    get numReqs()       { return this._reqs.count; },
    get numEventInvs()  { return this._eventInvs.count; },
    get numGroupInvs()  { return this._groupInvs.count; },
    // ----------- End Notifications -----------------//

    get apiKey() {
        return this._apiKey;
    },
    get secret() {
        return this._secret;
    },
    get loggedIn() {
        return this._loggedIn;
    },
    get loggedInUser() {
        return this._loggedInUser;
    },
    savedSessionStart: function() {
        this.sessionStart(
          this._prefService.getCharPref( 'extensions.facebook.session_key' ),
          this._prefService.getCharPref( 'extensions.facebook.session_secret' ),
          this._prefService.getCharPref( 'extensions.facebook.uid' ),
          true
        );
    },
    sessionStart: function(sessionKey, sessionSecret, uid, saved) {
        debug( 'sessionStart', sessionKey, sessionSecret, uid );
        if (!sessionKey || !sessionSecret || !uid) return;
        this._sessionKey    = sessionKey;
        this._sessionSecret = sessionSecret;
        this._loggedIn      = true;
        this._uid           = uid;

        if( !saved ) {
          // persist API sessions across the Firefox shutdown
          this.savePref( 'extensions.facebook.session_key', this._sessionKey );
          this.savePref( 'extensions.facebook.session_secret', this._sessionSecret );
          this.savePref( 'extensions.facebook.uid', this._uid );
        }

        this._timer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
        this._timer.initWithCallback(this._checker, BASE_CHECK_INTERVAL/5, Ci.nsITimer.TYPE_REPEATING_SLACK);

        // fire off another thread to get things started
        this._oneShotTimer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
        this._oneShotTimer.initWithCallback(this._initialize, 1, Ci.nsITimer.TYPE_ONE_SHOT);
    },
    savePref: function( pref_name, pref_val ) {
        this._prefService.unlockPref( pref_name, this._sessionSecret );
        this._prefService.setCharPref( pref_name, pref_val );
        this._prefService.lockPref( pref_name, this._sessionSecret );
    },
    sessionEnd: function() {
        debug('sessionEnd');
        // remove session info from prefs because of explicit login
        this.savePref( 'extensions.facebook.session_key', "" );
        this.savePref( 'extensions.facebook.session_secret', "" );
        this.savePref( 'extensions.facebook.uid', "" );

        this.initValues();
        this._timer.cancel();
        this._oneShotTimer.cancel();
        this.notify(null, 'facebook-session-end', null);
    },
    hintPageLoad: function(fbPage) {
        if (fbPage)
            this._lastFBLoad = Date.now();
        else
            this._lastPageLoad = Date.now();
    },
    initValues: function() {
        this._sessionKey    = null;
        this._sessionSecret = null;
        this._uid           = null;
        this._loggedIn      = false;
        this._loggedInUser  = null;

        this._messages      = null; // CountedNotif
        this._pokes         = null; // CountedNotif
        this._groupInvs     = null; // SetNotif
        this._eventInvs     = null; // SetNotif
        this._reqs          = null; // SetNotif

        this._friendDict   = {};
    	this._albumDict = {};

        this._pendingRequest = false;
        this._pendingRequests = [];
        this._lastCallId     = 0;
        this._lastChecked    = 0;
        this._lastFBLoad     = 0;
        this._lastPageLoad   = 0;
        this._lastCheckedFriends = 0;
    },
    checkNotifications: function(onInit){
        this.callMethod('facebook.notifications.get', [], function(data) {
            if( onInit ){
                fbSvc._messages = new CountedNotif( data.messages,'facebook-msgs-updated', fbSvc
                    , function( msgCount ) {
                        vdebug( "msgCount", msgCount );
                        var text = 'You have ' + ( msgCount==1 ? 'a new message' : 'new messages.' );
                        fbSvc.showPopup('you.msg', 'chrome://facebook/content/mail_request.gif',
                                         text, 'http://www.facebook.com/mailbox.php');
                    } );
                fbSvc._pokes = new CountedNotif( data.pokes, 'facebook-pokes-updated', fbSvc
                    , function( pokeCount ) {
                        vdebug( "pokeCount", pokeCount );
                        if( pokeCount > 0 ) {
                          var text = 'You have been ';
                          if( 1 == pokeCount )
                            text += 'poked.';
                          else if( 4 >= pokeCount )
                            text += 'poked ' + pokeCount + ' times.';
                          else
                            text += 'poked many times.';

                          fbSvc.showPopup('you.poke', 'chrome://facebook/content/poke.gif',
                                          text, 'http://www.facebook.com/home.php');
                        }
                    } );
                fbSvc._groupInvs = new SetNotif( data.group_invites..gid, 'facebook-group-invs-updated', fbSvc, null );
                fbSvc._eventInvs = new SetNotif( data.event_invites..eid, 'facebook-event-invs-updated', fbSvc, null );
                fbSvc._reqs      = new SetNotif( data.friend_requests..uid, 'facebook-reqs-updated', fbSvc
                    , function( self, delta ) {
                        fbSvc.getUsersInfo(delta, function(users) {
                            debug( "Got friend reqs", users.length )
                            for each (var user in users) {
                                self.items[user.id] = user;
                                fbSvc.notify(user, 'facebook-new-req', user.id);
                                fbSvc.showPopup('you.req', user.pic_sq, user.name + ' wants to be your friend',
                                               'http://www.facebook.com/reqs.php');
                            }
                        });
                    });
            }
            else {
                fbSvc._messages.update( data.messages );
                fbSvc._pokes.update( data.pokes );
                fbSvc._groupInvs.update( data.group_invites..gid );
                fbSvc._eventInvs.update( data.event_invites..eid );
                fbSvc._reqs.update( data.friend_requests..uid );
            }
        })
    },
    parseUsers: function(user_data) {
        user_elts = user_data..user;
        users = {};
        for each ( var user in user_elts ){
            // note: for name and status, need to utf8 decode them using
            // the decodeURIComponent(escape(s)) trick - thanks
            // http://ecmanaut.blogspot.com/2006/07/encoding-decoding-utf8-in-javascript.html
            var name   = decodeURIComponent(escape(String(user.name))),
                id     = String(user.uid),
                status = decodeURIComponent(escape(String(user.status.message))),
                stime  = !status ? 0 : Number(user.status.time),
                ptime  = Number(user.profile_update_time),
                notes  = Number(user.notes_count),
                wall   = Number(user.wall_count),
                pic    = String(decodeURI(user.pic_small)),
                pic_sq = String(decodeURI(user.pic_square));
            if (!pic) {
                pic = pic_sq = 'chrome://facebook/content/t_default.jpg';
            }
            users[id] = new facebookUser(id, name, pic, pic_sq, status, stime, ptime, notes, wall);
            vdebug( id, name, pic );
        }
        return users;
    },
    checkAlbums: function(window) {
      if( 0 == window ) { // initialization
        debug("Initial album check...");
        var query = " SELECT aid, owner, modified, size FROM album "
          + " WHERE owner IN (SELECT uid2 FROM friend WHERE uid1 = :user) and size > 0;";
        query = query.replace( /:user/g, fbSvc._uid );
        this.callMethod('facebook.fql.query', ['query='+query], function(data) {
          for each( var album in data..album ) {
            var aid      = Number(album.aid),
                size     = Number(album.size),
                modified = Number(album.modified),
                owner    = Number(album.owner);
            fbSvc._albumDict[ aid ] = { 'modified': modified,
                                        'size': size,
                                        'owner': owner };
            vdebug( "An album", aid, owner, modified );
          }
        });
      }
      // don't check for album changes if not going to show notifications
      else if( this._prefService.getBoolPref('extensions.facebook.notifications.toggle') &&
               this._prefService.getBoolPref('extensions.facebook.notifications.friend.album') ) {
        debug("Album check...", window);
        var query = " SELECT aid, owner, name, modified, size, link FROM album "
          + " WHERE owner IN (SELECT uid2 FROM friend WHERE uid1 = :user )"
         + " AND modified > (now() - :window) AND size > 0;";
        query = query.replace( /:user/g, fbSvc._uid )
                     .replace( /:window/g, Math.floor(window/1000) + 30 ); // 30 sec of wiggle room
        debug(query);
        this.callMethod('facebook.fql.query', ['query='+query], function(data) {
          for each( var album in data..album ) {
            var aid      = Number(album.aid),
                size     = Number(album.size),
                modified = Number(album.modified),
                name     = String(album.name),
                link     = decodeURIComponent(escape(String(album.link))),
                owner    = Number(album.owner);
            debug( "Modified album!", owner, name, modified, link );
            var album_owner = fbSvc._friendDict[owner];
            var pvs_album = fbSvc._albumDict[aid];
            if( album_owner ) {
              if( pvs_album ) { // album already existed
                if( size > pvs_album.size ) {
                  fbSvc.showPopup( 'friend.album', 'chrome://facebook/skin/photo.gif',
                                   album_owner.name + ' added new photos to "' + name + '"',
                                   link + "&src=fftb" );
                }
              }
              else {
                fbSvc.showPopup( 'friend.album', 'chrome://facebook/skin/photo.gif',
                                 album_owner.name + ' created the album "' + album.name + '"',
                                 link + "&src=fftb" );
              }
              fbSvc._albumDict[aid] = { 'modified': modified,
                                        'owner': owner,
                                        'size': size };
            }
          }
        });
      }
    },
    checkUsers: function(onInit) {
        var friendUpdate = false;
        var query = ' SELECT uid, name, status, pic_small, pic_square, wall_count, notes_count, profile_update_time'
                  + ' FROM user WHERE uid = :user '
                  + ' OR uid IN (SELECT uid2 FROM friend WHERE uid1 = :user );';
        query = query.replace( /:user/g, fbSvc._uid );
        this.callMethod('facebook.fql.query', ['query='+query], function(data) {
            fbSvc._lastCheckedFriends = Date.now();

            // update the friends in place for non-onInit cases
            // because we don't care about removing the defriended ... otherwise we'd
            // make a new friends array every time so that we handle losing friends properly
            friendDict = fbSvc.parseUsers(data);

            var loggedInUser = friendDict[fbSvc._uid];
            debug( "loggedInUser", loggedInUser.name );
            delete friendDict[fbSvc._uid];

            // Check for user's info changes
            if (fbSvc._loggedInUser) {
                if (fbSvc._loggedInUser.wall != loggedInUser.wall) {
                    fbSvc.notify(null, 'facebook-wall-updated', loggedInUser.wall);
                    if (fbSvc._loggedInUser.wall < loggedInUser.wall) {
                        fbSvc.showPopup( 'you.wall', 'chrome://facebook/content/wall_post.gif', 'Someone wrote on your wall',
                                         'http://www.facebook.com/profile.php?id=' + fbSvc._uid + '&src=fftb#wall');
                    }
                }
                fbSvc._loggedInUser = loggedInUser;
            } else {
                fbSvc._loggedInUser = loggedInUser;
                fbSvc.notify(fbSvc._loggedInUser, 'facebook-session-start', fbSvc._loggedInUser.id);
                debug('logged in: howdy', fbSvc._loggedInUser.name);
            }
            debug('check done with logged in user');

            // Check for user's friends' info changes
            for each (var friend in friendDict) {
                if (!onInit) {
                    if (!fbSvc._friendDict[friend.id]) {
                        fbSvc.notify(friend, 'facebook-new-friend', friend['id']);
                        fbSvc.showPopup('you.friend', friend.pic_sq, friend.name + ' is now your friend',
                        'http://www.facebook.com/profile.php?id=' + friend.id + '&src=fftb');
                        fbSvc._friendCount++; // increment the count
                        friendUpdate = true;
                    } else {
                        checkProf = true; // only check if not displaying another notification
                        if (fbSvc._friendDict[friend.id].status != friend.status) {
                            if (friend.status) {
                                fbSvc.notify(friend, 'facebook-friend-updated', 'status');
                                checkProf = !fbSvc.showPopup('friend.status', friend.pic_sq, friend.name + ' is now ' + RenderStatusMsg(friend.status),
                                'http://www.facebook.com/profile.php?id=' + friend.id + '&src=fftb#status');
                            } else {
                                fbSvc.notify(friend, 'facebook-friend-updated', 'status-delete');
                            }
                            friendUpdate = true;
                        }
                        if (fbSvc._friendDict[friend.id].wall < friend.wall) {
                            fbSvc.notify(friend, 'facebook-friend-updated', 'wall');
                            checkProf = checkProf && !fbSvc.showPopup('friend.wall', friend.pic_sq, 'Someone wrote on ' + friend.name + "'s wall",
                            'http://www.facebook.com/profile.php?id=' + friend.id + '&src=fftb#wall');
                            vdebug('wall count updated', fbSvc._friendDict[friend.id].wall, friend.wall);
                        }
                        if (fbSvc._friendDict[friend.id].notes < friend.notes) {
                            fbSvc.notify(friend, 'facebook-friend-updated', 'notes');
                            checkProf = checkProf && !fbSvc.showPopup('friend.note', friend.pic_sq, friend.name + ' wrote a note.',
                              'http://www.facebook.com/notes.php?id=' + friend.id + '&src=fftb');
                            vdebug('note count updated', fbSvc._friendDict[friend.id].notes, friend.notes);
                        }
                        if (checkProf && fbSvc._friendDict[friend.id].ptime != friend.ptime) {
                            fbSvc.notify(friend, 'facebook-friend-updated', 'profile');
                            fbSvc.showPopup('friend.profile', friend.pic_sq, friend.name + ' updated his/her profile',
                            'http://www.facebook.com/profile.php?id=' + friend.id + '&src=fftb&highlight');
                            friendUpdate = true;
                        }
                    }
                    fbSvc._friendDict[friend.id] = friend;
                }
            }
            if( onInit )
              fbSvc._friendDict = friendDict;
            if (onInit || friendUpdate) {
                debug('sending notification');
                fbSvc.notify(null, 'facebook-friends-updated', null);
            }
            debug('done checkUsers', friendUpdate);
        });
    },
    getFriends: function(count) {
        debug( "getFriends called!");
        var friend_arr = [];
        for each( var f in fbSvc._friendDict )
          friend_arr.push( f );
        count.value = friend_arr.length;
        return friend_arr;
    },
    notify: function( observer, what, arg ){
        debug( "notify", what, arg );
        this._observerService.notifyObservers( observer, what, arg );
    },
    // deprecated: replaced by fql query in checkUsers
    getUsersInfo: function(users, callback) {
        this.callMethod('facebook.users.getInfo', ['users='+users.join(','),
                        'fields=name,status,pic_small,pic_square,wall_count,notes_count,profile_update_time'],
                        function(data) {
            callback(fbSvc.parseUsers(data));
        });
    },
    generateSig: function (params) {
        var str = '';
        params.sort();
        for (var i = 0; i < params.length; i++) {
            str += params[i];
        }
        str += this._sessionSecret;
        return MD5(str);
    },
    // Note that this is intended to call non-login related Facebook API
    // functions - ie things other than facebook.auth.*.  The login-related
    // calls are done in the chrome layer because
    // Also note that this is synchronous so you should not call it from the UI.
    callMethod: function (method, params, callback, secondTry) {
        if (!this._loggedIn) return null;

        var origParams = params.slice(0); // easy way to make a deep copy of the array
        params.push('method=' + method);
        params.push('session_key=' + this._sessionKey);
        params.push('api_key=' + this._apiKey);
        params.push('v=1.0');
        var callId = Date.now();
        if (callId <= this._lastCallId) {
            callId = this._lastCallId + 1;
        }
        this._lastCallId = callId;
        params.push('call_id=' + callId);
        params.push('sig=' + this.generateSig(params));
        var message = params.join('&');
        var findNamespace = /xmlns=(?:"[^"]*"|'[^']*')/;
        try {
            // Yuck...xmlhttprequest doesn't always work so we have to do this
            // the hard way.  Thanks to Manish from Flock for the tip!
            var restserver = 'http://api.facebook.com/restserver.php';
            var channel = Cc['@mozilla.org/network/io-service;1'].getService(Ci.nsIIOService)
                               .newChannel(restserver, null, null)
                               .QueryInterface(Ci.nsIHttpChannel);
            var upStream = Cc['@mozilla.org/io/string-input-stream;1'].createInstance(Ci.nsIStringInputStream);
            upStream.setData(message, message.length);
            channel.QueryInterface(Ci.nsIUploadChannel)
                   .setUploadStream(upStream, "application/x-www-form-urlencoded", -1);
            channel.requestMethod = "POST";
            var listener = {
                onDataAvailable: function(request, context, inputStream, offset, count) {
                    var sis = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
                    sis.init(inputStream);
                    this.resultTxt += sis.read(count);
                },
                onStartRequest: function(request, context) {
                    debug('starting request', method, callId);
                    this.resultTxt = '';
                    if (fbSvc._pendingRequests.length) {
                        (fbSvc._pendingRequests.shift())();
                    } else {
                        fbSvc._pendingRequest = false;
                    }
                },
                onStopRequest: function(request, context, statusCode) {
                    if (statusCode == Components.results.NS_OK) {
                        this.resultTxt = this.resultTxt.substr(this.resultTxt.indexOf("\n") + 1);
                        vdebug('received text:', this.resultTxt);
                        var xmldata = new XML(this.resultTxt.replace(findNamespace,""));
                        if ((String)(xmldata.error_code)) { // need to cast to string or check will never fail
                            if (xmldata.error_code == 102) {
                                debug('session expired, logging out.');
                                fbSvc.sessionEnd();
                            } else if (xmldata.error_code == 4) {
                                // rate limit hit, let's just cancel this request, we'll try again soon enough.
                                debug('RATE LIMIT ERROR');
                            } else {
                                debug('API error:');
                                debug(xmldata);
                                if (!secondTry) {
                                    debug('TRYING ONE MORE TIME');
                                    fbSvc.callMethod(method, origParams, callback, true);
                                }
                            }
                        } else {
                            callback(xmldata);
                        }
                    }
                }
            };
            if (this._pendingRequest) {
                this._pendingRequests.push(function() {
                    channel.asyncOpen(listener, null);
                });
            } else {
                this._pendingRequest = true;
                channel.asyncOpen(listener, null);
            }
        } catch (e) {
            debug('Exception sending REST request: ', e);
            return null;
        }
    },
    showPopup: function(type, pic, label, url) {
        if (!this._prefService.getBoolPref('extensions.facebook.notifications.toggle') ||
            !this._prefService.getBoolPref('extensions.facebook.notifications.' + type)) {
            return false;
        }
        debug('showPopup', type, pic, label, url);
//        try { // try the firefox alerter
//            var alerts = Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService);
//            alerts.showAlertNotification(pic, 'Facebook Notification', label, true, url, this._alertObserver);
//        } catch(e) {

        try {
          var use_growl = this._prefService.getBoolPref('extensions.facebook.notifications.growl');
          if (use_growl) { // use growl if it is built in
            var growlexec = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
            var process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
            growlexec.initWithPath(this._prefService.getCharPref('extensions.facebook.notifications.growlpath'));
            if (growlexec.exists()) {
                process.init(growlexec);
                var args = ['-n', 'Firefox', '-a', 'Firefox', '-t', 'Facebook Notification', '-m', label];
                process.run(false, args, args.length);
            }
          }
          else
            throw null;
        } catch (e2) { // failing that, open up a window with the notification
            if (e2) debug('caught', e2);
            this._numAlertsObj.value++;
            var win = Cc["@mozilla.org/appshell/appShellService;1"].getService(Ci.nsIAppShellService)
                                                                  .hiddenDOMWindow;
            var left = win.screen.width - 215;
            var top  = win.screen.height - 105*this._numAlertsObj.value;
            win.openDialog('chrome://facebook/content/notifier.xul', '_blank',
                           'chrome,titlebar=no,popup=yes,left=' + left + ',top=' + top + ',width=210,height=100',
                           pic, label, url, this._numAlertsObj);
        }
//        }
        return true;
    }
};

// boilerplate stuff
var facebookFactory = {
    createInstance: function (aOuter, aIID) {
        debug('createInstance');
        if (aOuter != null) {
            throw Components.results.NS_ERROR_NO_AGGREGATION;
        }
        return (new facebookService()).QueryInterface (aIID);
    }
};
var facebookModule = {
    registerSelf: function (aCompMgr, aFileSpec, aLocation, aType) {
        debug('registerSelf');
        aCompMgr = aCompMgr.QueryInterface(Ci.nsIComponentRegistrar);
        aCompMgr.registerFactoryLocation(CLASS_ID, CLASS_NAME, CONTRACT_ID, aFileSpec, aLocation, aType);
    },
    unregisterSelf: function(aCompMgr, aLocation, aType) {
        debug('unregisterSelf');
        aCompMgr = aCompMgr.QueryInterface(Ci.nsIComponentRegistrar);
        aCompMgr.unregisterFactoryLocation(CLASS_ID, aLocation);
    },
    getClassObject: function (aCompMgr, aCID, aIID) {
        debug('getClassObject');
        if (!aIID.equals (Ci.nsIFactory))
            throw Components.results.NS_ERROR_NOT_IMPLEMENTED;

        if (aCID.equals (CLASS_ID))
            return facebookFactory;

        throw Components.results.NS_ERROR_NO_INTERFACE;
    },
    canUnload: function(compMgr) {
        debug('canUnload');
        return true;
    }
};
function NSGetModule(compMgr, fileSpec) {
    debug('NSGetModule');
    return facebookModule;
}

function facebookUser(id, name, pic, pic_sq, status, stime, ptime, notes, wall) {
    this.id     = id;
    this.name   = name;
    this.pic    = pic;
    this.pic_sq = pic_sq;
    this.status = status;
    this.stime  = stime;
    this.ptime  = ptime;
    this.notes  = notes;
    this.wall   = wall;
}
facebookUser.prototype = {
    // nsISupports implementation
    QueryInterface: function (iid) {
        if (!iid.equals(Ci.fbIFacebookUser) &&
            !iid.equals(Ci.nsISupports))
            throw Components.results.NS_ERROR_NO_INTERFACE;
        return this;
    }
};

// just copied from lib.js, lame but i don't feel like including the whole
// file in here for this one function.
function RenderStatusMsg(msg) {
    msg = msg.replace(/\s*$/g, '');
    if (msg && '.?!\'"'.indexOf(msg[msg.length-1]) == -1) {
        msg = msg.concat('.');
    }
    return msg;
}

debug('loaded facebook.js');
