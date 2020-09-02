"use strict";
require('dotenv').config()

const Parse = require("parse/node");
const express = require('express');
const bodyParser = require('body-parser');
const moment = require("moment");
var jwt = require('jsonwebtoken');
const crypto = require('crypto');

const { videoToken, ChatGrant, AccessToken } = require('./tokens');
const axios = require('axios');
const qs = require('qs');

var cors = require('cors')

const Twilio = require("twilio");


Parse.initialize(process.env.REACT_APP_PARSE_APP_ID, process.env.REACT_APP_PARSE_JS_KEY, process.env.PARSE_MASTER_KEY);
Parse.serverURL = process.env.REACT_APP_PARSE_DATABASE_URL;


const masterTwilioClient = Twilio(process.env.TWILIO_MASTER_SID ? process.env.TWILIO_MASTER_SID : "AC123",
    process.env.TWILIO_MASTER_AUTH_TOKEN ? process.env.TWILIO_MASTER_AUTH_TOKEN : "123");


const app = express();
app.use(cors())
const confCache = {};
const confIDToConf = {};
const userToAuthData = {};
const userToWorkspaces = {};
var sidToRoom = {};

let ClowdrInstance = Parse.Object.extend("ClowdrInstance");
let ClowdrInstanceAccess = Parse.Object.extend("ClowdrInstanceAccess");

let InstanceConfig = Parse.Object.extend("InstanceConfiguration");
let BreakoutRoom = Parse.Object.extend("BreakoutRoom");
let PrivilegedAction = Parse.Object.extend("PrivilegedAction");
var InstancePermission = Parse.Object.extend("InstancePermission");
let LiveActivity = Parse.Object.extend("LiveActivity");
let UserProfile = Parse.Object.extend("UserProfile");
let BondedChannel = Parse.Object.extend("BondedChannel");


function generateRandomString(length) {
    return new Promise((resolve, reject) => {
        crypto.randomBytes(length,
            function (err, buffer) {
                if (err) {
                    return reject(err);
                }
                var token = buffer.toString('hex');
                return resolve(token);
            });
    })
}

const sendTokenResponse = (token, roomName, res) => {
    res.set('Content-Type', 'application/json');
    res.send(
        JSON.stringify({
            token: token.toJwt(),
            roomName: roomName
        })
    );
};
let membersCache = {};
let Room = Parse.Object.extend("BreakoutRoom");
let SocialSpace = Parse.Object.extend("SocialSpace");
let User = Parse.Object.extend("User");

async function populateActiveChannels(conf) {
    //TODO map to a single conference?
    let roomQuery = new Parse.Query(BreakoutRoom);
    roomQuery.equalTo("conference", conf)
    roomQuery.include(["members"]);
    let rooms = await roomQuery.find({ useMasterKey: true });
    return rooms;
}

var adminRole;

async function getParseAdminRole() {
    if (adminRole)
        return adminRole;
    let roleQ = new Parse.Query(Parse.Role);
    roleQ.equalTo("name", "ClowdrSysAdmin");
    adminRole = await roleQ.first({ useMasterKey: true });
    return adminRole;
}

var roleCache = {};

async function getOrCreateRole(confID, priv) {
    // if(typeof(confID) === 'object'){
    //     confID = confID.id;
    // }
    let name = confID + "-" + priv;
    console.log("Get or create role: " + name)
    // if (roleCache[name]){
    //     return roleCache[name];
    // }
    try {
        var roleQ = new Parse.Query(Parse.Role);
        roleQ.equalTo("name", name);
        roleQ.include("users");
        let role = await roleQ.first({ useMasterKey: true });
        if (!role) {
            let roleACL = new Parse.ACL();

            let adminRole = await getParseAdminRole();
            roleACL.setPublicReadAccess(true);
            let newrole = new Parse.Role(name, roleACL);
            newrole.getRoles().add(adminRole);
            try {
                newrole = await newrole.save({}, { useMasterKey: true });
            } catch (err) {
                console.log("Did not actually create it:")
                console.error(err);
            }
            roleCache[name] = newrole;
        } else {
            roleCache[name] = role;
        }
    } catch (err) {
        console.log("Unable to create role")
        console.error(err);
        return null;
    }
    return roleCache[name];
}

var emailsToParseUser;
var allUsersPromise;
var parseUIDToProfiles;


function getAllUsers() {
    if (allUsersPromise)
        return allUsersPromise;
    if (emailsToParseUser) {
        return new Promise((resolve) => resolve(emailsToParseUser));
    }
    let usersPromise = new Promise(async (resolve, reject) => {
        emailsToParseUser = {};
        try {
            let parseUserQ = new Parse.Query(Parse.User);
            parseUserQ.limit(1000);
            parseUserQ.withCount();
            parseUserQ.include("profiles");
            let nRetrieved = 0;
            let { count, results } = await parseUserQ.find({ useMasterKey: true });
            nRetrieved = results.length;
            // console.log(count);
            // console.log(results);
            results.map((u) => {
                emailsToParseUser[u.get("username")] = u;
            });
            while (nRetrieved < count) {
                // totalCount = count;
                let parseUserQ = new Parse.Query(Parse.User);
                parseUserQ.limit(1000);
                parseUserQ.skip(nRetrieved);
                let results = await parseUserQ.find({ useMasterKey: true });
                // results = dat.results;
                nRetrieved += results.length;
                if (results)
                    results.map((u) => {
                        emailsToParseUser[u.get("username")] = u;
                    });
            }
            // let promises =[];
            // for(let user of Object.values(emailsToParseUser)){
            //     let fakeSession = Parse.Object.extend("_Session");
            //     let newSession = new fakeSession();
            //     // console.log(user)
            //     newSession.set("user", user);
            //     newSession.set("createdWith", {action: "login", "authProvider": "clowdr"});
            //     newSession.set("restricted", false);
            //     newSession.set("expiresAt", moment().add("1", "year").toDate());
            //     newSession.set("sessionToken", "r:" + await generateRandomString(24))
            //     promises.push(newSession.save({}, {useMasterKey: true}));
            // }
            // await Promise.all(promises);
            allUsersPromise = null;
            resolve(emailsToParseUser);
        } catch (err) {
            console.log("In get all users ")
            console.error(err);
            reject(err);
        }
    })
    let profilesPromise = new Promise(async (resolve, reject) => {
        parseUIDToProfiles = {};
        try {
            let parseUserQ = new Parse.Query(UserProfile);
            parseUserQ.limit(1000);
            parseUserQ.withCount();
            let nRetrieved = 0;
            let { count, results } = await parseUserQ.find({ useMasterKey: true });
            nRetrieved = results.length;
            // console.log(count);
            // console.log(results);
            results.map((u) => {
                if (!parseUIDToProfiles[u.get("user").id]) {
                    parseUIDToProfiles[u.get("user").id] = {};
                }
                parseUIDToProfiles[u.get("user").id][u.get("conference").id] = u;
            });
            while (nRetrieved < count) {
                // totalCount = count;
                let parseUserQ = new Parse.Query(UserProfile);
                parseUserQ.limit(1000);
                parseUserQ.skip(nRetrieved);
                let results = await parseUserQ.find({ useMasterKey: true });
                // results = dat.results;
                nRetrieved += results.length;
                if (results)
                    results.map((u) => {
                        if (!parseUIDToProfiles[u.get("user").id]) {
                            parseUIDToProfiles[u.get("user").id] = {};
                        }
                        parseUIDToProfiles[u.get("user").id][u.get("conference").id] = u;
                    });
            }
            allUsersPromise = null;
            resolve(parseUIDToProfiles);
        } catch (err) {
            console.log("In get all user profiles ")
            console.error(err);
            reject(err);
        }
    })
    allUsersPromise = Promise.all([usersPromise, profilesPromise]);
    return allUsersPromise;
}

async function getConferenceByID(confID) {
    if (confIDToConf[confID])
        return confIDToConf[confID];
    let q = new Parse.Query(ClowdrInstance);
    let conf = await q.get(confID, { useMasterKey: true });

    await initChatRooms(conf);
    confIDToConf[conf.id] = conf;

    return conf;
}

async function initChatRooms(r) {
    try {
        r.rooms = await populateActiveChannels(r);
        r.config = await getConfig(r);

        try {
            r.twilio = Twilio(r.config.TWILIO_ACCOUNT_SID, r.config.TWILIO_AUTH_TOKEN);
        } catch (err) {
            console.log(`[initChatRooms]: failed to connect to Twilio with account ${r.config.TWILIO_ACCOUNT_SID} and auth token ${r.config.TWILIO_AUTH_TOKEN}. Check your credentials`);
            return;
        }

        if (!r.config.TWILIO_CHAT_SERVICE_SID) {
            let newChatService = await r.twilio.chat.services.create({ friendlyName: 'clowdr_chat' });
            await addOrReplaceConfig(r, "TWILIO_CHAT_SERVICE_SID", newChatService.sid);
        }

        let socialSpaceQ = new Parse.Query("SocialSpace");
        socialSpaceQ.equalTo("conference", r);
        socialSpaceQ.equalTo("name", "Lobby");
        r.lobbySocialSpace = await socialSpaceQ.first({ useMasterKey: true });

        //Make sure that there is a record of the instance for enrollments
        let accessQ = new Parse.Query(ClowdrInstanceAccess);
        accessQ.equalTo("instance", r);
        let accessRecord = await accessQ.first({ useMasterKey: true });
        if (!accessRecord) {
            accessRecord = new ClowdrInstanceAccess();
            let role = await getOrCreateRole(r.id, "conference");
            let acl = new Parse.ACL();
            try {
                acl.setRoleReadAccess(r.id + "-conference", true);
                accessRecord.set("instance", r);
                accessRecord.setACL(acl);
                await accessRecord.save({}, { useMasterKey: true });
            } catch (err) {
                console.log("on room " + r.id)
                console.error(err);
            }
        }

        //This is the first time we hit this conference on this run, so we should also grab the state of the world from twilio

        let roomsInTwilio = await r.twilio.video.rooms.list();

        let modRole = await getOrCreateRole(r.id, "moderator");

        for (let room of roomsInTwilio) {
            if (room.status === 'in-progress') {
                if (r.rooms.filter((i) => i.get("twilioID") === room.sid).length === 0) {
                    //make a new room with room.uniqueName
                    let parseRoom = new BreakoutRoom();
                    parseRoom.set("conference", r);
                    parseRoom.set("twilioID", room.sid);
                    parseRoom.set("title", room.uniqueName);
                    parseRoom.set("persistence", "ephemeral");
                    parseRoom = await parseRoom.save();
                    let acl = new Parse.ACL();
                    acl.setPublicReadAccess(false);
                    acl.setPublicWriteAccess(false);
                    acl.setRoleReadAccess(modRole, true);
                    acl.setRoleReadAccess(await getOrCreateRole(r.id, "conference"), true);
                    parseRoom.setACL(acl, { useMasterKey: true });
                    await parseRoom.save({}, { useMasterKey: true });
                    sidToRoom[room.sid] = parseRoom;
                    r.rooms.push(parseRoom);
                }
            }
        }

        for (let parseRoom of r.rooms) {
            try {
                if (!parseRoom.get("twilioID") && parseRoom.get("persistence") !== "ephemeral")
                    continue; //persistent room, not occupied.
                let found = roomsInTwilio.filter((i) => i.status === 'in-progress' && i.sid === parseRoom.get("twilioID"));
                if (found.length === 1 && found[0].status === 'in-progress') {
                    sidToRoom[parseRoom.get("twilioID")] = parseRoom;
                    //sync members
                    let participants = await r.twilio.video.rooms(parseRoom.get("twilioID")).participants.list();
                    for (let participant of participants) {
                        let uid = participant.identity;
                        let userFindQ = new Parse.Query(UserProfile);
                        try {
                            let user = await userFindQ.get(uid, { useMasterKey: true });
                            if (!parseRoom.get("members")) {
                                parseRoom.set("members", [user]);
                            } else {
                                if (parseRoom.get("members").filter((u) => u.id === uid).length === 0)
                                    parseRoom.get("members").push(user);
                            }
                        } catch (err) {
                            console.log("Missing participant: " + uid)
                            console.error(err);
                        }
                    }
                    let membersToRemove = [];
                    if (parseRoom.get("members")) {
                        for (let member of parseRoom.get("members")) {
                            let found = participants.filter((p) => {
                                let uid = p.identity;
                                return uid === member.id && p.status === "connected";
                            });
                            if (found.length === 0) {
                                //remove that member
                                membersToRemove.push(member.id);
                            }
                        }
                        let newMembers = parseRoom.get("members").filter((member) => !membersToRemove.includes(member.id));
                        parseRoom.set("members", newMembers);
                    }
                    await parseRoom.save({}, { useMasterKey: true });
                } else {
                    //room no logner exists
                    try {
                        if (parseRoom.get("persistence") === "persistent") {
                            parseRoom.set("twilioID", null);
                            await parseRoom.save({}, { useMasterKey: true });
                        } else {
                            if (parseRoom.get("twilioChatID")) {
                                await r.twilio.chat.services(r.config.TWILIO_CHAT_SERVICE_SID).channels(parseRoom.get("twilioChatID")).remove();
                            }
                            await parseRoom.destroy({ useMasterKey: true });
                            r.rooms = r.rooms.filter((r) => r.id !== parseRoom.id);
                        }
                    } catch (err) {
                        console.log("Unable to delete " + parseRoom.id)
                        console.error(err);
                    }
                }
            } catch (err) {
                console.log("initialization error on " + parseRoom.id)
                console.error(err);
                console.log(err.stack)
            }
        }

        let adminRole = await getParseAdminRole();
        let adminsQ = adminRole.getUsers().query();
        adminsQ.limit(1000);
        let admins = await adminsQ.find({ useMasterKey: true });
        let promises = [];
        for (let admin of admins) {
            promises.push(ensureUserHasTeamRole(admin, r, await getOrCreateRole(r.id, "conference")));
        }

        //for twilio chat, make sure that there is a #general room
        // r.twilio.chat.services(r.config.TWILIO_CHAT_SERVICE_SID);
        // promises.push(chatService.channels.list().then((list) => {
        //         for (let chan of list) {
        //             if (chan.uniqueName !== "#general") {
        //                 console.log("Deleting " + chan.sid)
        //                 return chatService.channels(chan.sid).remove();
        //             }
        //         }
        //     }
        // ));
        // promises.push(
        //     chatService.channels("#general").fetch().then((chan)=>{
        //         if(!chan.sid){
        //             return chatService.channels.create({uniqueName: "#general", friendlyName: "#general", type: "public"}).catch(err=>{});
        //         }
        //
        //         if(chan.friendlyName === "#general")
        //             return;
        //         return chatService.channels("#general").update({uniqueName: "#general", friendlyName: "#general"}).then((chan)=>{
        //         }).catch(err=>{
        //             console.log("Unable to update channel")
        //             console.log(chan);
        //         });
        //     }).catch(err=>{
        //         console.error(err);
        //     })
        // )

        await Promise.all(promises).catch((err) => {
            console.error(err);
        });
    } catch (err) {
        console.log('[getConference]: outter err: ' + err);
    }
}

var userNotifications = {};

async function pushToUserStream(parseUser, parseConference, topic) {
    let activtyData;
    if (!userNotifications[parseUser.id] || !userNotifications[parseUser.id][parseConference.id] ||
        (topic && !userNotifications[parseUser.id][parseConference.id][topic])) {

        let liveActivityQ = new Parse.Query("LiveActivity");
        liveActivityQ.equalTo("user", parseUser);
        liveActivityQ.equalTo("conference", parseConference);
        liveActivityQ.equalTo("topic", topic);
        activtyData = await liveActivityQ.first({ useMasterKey: true });
        if (!activtyData) {
            activtyData = new LiveActivity();
            activtyData.set("user", parseUser);
            activtyData.set("conference", parseConference);
            activtyData.set("topic", topic);
            let acl = new Parse.ACL();
            acl.setPublicReadAccess(false);
            acl.setReadAccess(parseUser, true);
            activtyData.setACL(acl);
        }
        if (!userNotifications[parseUser.id])
            userNotifications[parseUser.id] = {};
        if (!userNotifications[parseUser.id][parseConference.id])
            userNotifications[parseUser.id][parseConference.id] = {};
        userNotifications[parseUser.id][parseConference.id][topic] = activtyData;
    } else {
        activtyData = userNotifications[parseUser.id][parseConference.id][topic];
    }
    await activtyData.save({}, { useMasterKey: true });

}
async function getConfig(conf) {
    let q = new Parse.Query(InstanceConfig)
    q.equalTo("instance", conf);
    let res = await q.find({ useMasterKey: true });
    let config = {};
    for (let obj of res) {
        config[obj.get("key")] = obj.get("value");
    }
    if (!config.FRONTEND_URL) {
        config.FRONTEND_URL = process.env.FRONTEND_URL;
    }
    if (!config.TWILIO_CALLBACK_URL) {
        config.TWILIO_CALLBACK_URL = process.env.TWILIO_CALLBACK_URL;
    }
    if (!config.TWILIO_ROOM_TYPE) {
        config.TWILIO_ROOM_TYPE = "group-small";
    }
    if (!config.AUTO_CREATE_USER) {
        config.AUTO_CREATE_USER = true;
    }
    // config.TWILIO_CALLBACK_URL = "https://clowdr-dev.ngrok.io/twilio/event";

    // console.log(JSON.stringify(config,null,2))
    return config;
}

async function ensureUserHasTeamRole(user, conf, role) {
    let confID = conf.id;
    // console.trace()
    if (userToWorkspaces[user.id] && userToWorkspaces[user.id][conf.id]) {
        return;
    }
    let debug = false;
    try {
        //Check in DB
        const roleQuery = new Parse.Query(Parse.Role);
        roleQuery.equalTo("users", user);
        roleQuery.equalTo("id", role.id);
        if (!role.id) {
            console.log("invalid role?")
            console.log(role);
            console.trace();
        }
        const roles = await roleQuery.find({ useMasterKey: true });
        if (!roles || roles.length === 0) {
            role.getUsers().add(user);
            let savedRole = await role.save(null, { useMasterKey: true, cascadeSave: true });
        } else if (debug) {
            console.log("Already has role? " + user.id)
        }
        if (!userToWorkspaces[user.id]) {
            userToWorkspaces[user.id] = {};
        }
        userToWorkspaces[user.id][conf.id] = 1;
    } catch (err) {
        console.log("Error in role")
        console.error(err);
    }
}

var privilegeRoles = {
    "createVideoRoom": null,
    "chat": null,
    "createVideoRoom-persistent": null,
    "createVideoRoom-group": null,
    "createVideoRoom-smallgroup": null,
    "createVideoRoom-peer-to-peer": null,
    'createVideoRoom-private': null,
    "moderator": null
};

async function getPrivileges() {
    let actionsQ = new Parse.Query(PrivilegedAction);
    actionsQ.include("action")
    actionsQ.include("role");
    let pactions = await actionsQ.find({ useMasterKey: true });
    console.log("Get privileges: " + pactions ? pactions.length : 0);

    Object.keys(privilegeRoles).map(actionName => {
        let action = pactions.find(act => act.get("action") === actionName);
        if (action) {
            privilegeRoles[actionName] = action;
        }
    });
}

async function processTwilioEvent(req, res) {
    let roomSID = req.body.RoomSid;
    console.log("Twilio event: " + req.body.StatusCallbackEvent + " " + req.body.RoomSid)
    try {
        // let room = sidToRoom[roomSID];
        if (req.body.StatusCallbackEvent === 'participant-connected') {

            let roomQ = new Parse.Query(BreakoutRoom);
            roomQ.equalTo("twilioID", roomSID);
            let room = await roomQ.first({ useMasterKey: true });

            let uid = req.body.ParticipantIdentity;
            let userFindQ = new Parse.Query(UserProfile);
            let user = await userFindQ.get(uid, { useMasterKey: true });
            if (!room.get("members")) {
                room.set("members", [user]);
            } else {
                if (room.get("members").filter((u) => u.id === uid).length === 0)
                    room.get("members").push(user);
            }
            await room.save({}, { useMasterKey: true });

            // let newUser = await roomsRef.child(req.body.RoomName).child("members").child(uid).set(true);
            // console.log("Added " + req.body.ParticipantIdentity + " to " + roomDBID + " count is now " + membersCache[roomDBID]);
            // ;
            // membersCache[req.body.RoomName]++;
        } else if (req.body.StatusCallbackEvent === 'participant-disconnected') {
            let roomQ = new Parse.Query(BreakoutRoom);
            roomQ.equalTo("twilioID", roomSID);
            let room = await roomQ.first({ useMasterKey: true });

            let uid = req.body.ParticipantIdentity;
            let userFindQ = new Parse.Query(User);
            if (!room.get("members")) {
                room.set("members", []);
            } else {
                room.set("members", room.get("members").filter((u) => u.id !== uid));
            }
            await room.save({}, { useMasterKey: true });

            // } else if(req.body.StatusCallbackEvent === '')
        } else if (req.body.StatusCallbackEvent === 'room-ended') {
            let roomQ = new Parse.Query(BreakoutRoom);
            roomQ.equalTo("twilioID", roomSID);
            let room = await roomQ.first({ useMasterKey: true });
            if (room) {
                if (room.get("persistence") === "persistent") {
                    console.log("Removing tid " + room.get("title"))
                    room.set("twilioID", null);
                    await room.save({}, { useMasterKey: true });
                } else {
                    await room.destroy({ useMasterKey: true });
                }
            } else {
                console.log("unable to destroy " + roomSID);
            }
        } else {
        }
    } catch
    (err) {
        console.error(err);
        // next(err);

    }
    console.log("DONE Twilio event: " + req.body.StatusCallbackEvent + " " + req.body.RoomSid)

    res.send();
}

var presenceCache = {};

function getUserPresence(profileID) {
    if (!presenceCache[profileID]) {
        let presenceQ = new Parse.Query("UserPresence");
        let prof = new UserProfile();
        prof.id = profileID;
        presenceQ.equalTo("user", prof);
        presenceCache[profileID] = presenceQ.first({ useMasterKey: true });
    }
    return presenceCache[profileID];
}

app.post("/webhook/zoom/participant", bodyParser.json(), bodyParser.urlencoded({ extended: false }), async (req, res) => {
    res.send();
    try {
        let meeting_id = req.body.payload.id;
        if (req.body.payload.object && req.body.payload.object.participant) {
            let registrant_id = req.body.payload.object.participant.id;
            console.log(req.body.event + "\t" + registrant_id)
            console.log(req.body)
            console.log(req.body.payload.object.participant)
            if (req.body.event === "meeting_participant_joined") {

            } else if (req.body.event === "meeting_participant_left") {

            }
        }
    } catch (err) {
        console.error(err);
    }
})


app.post("/twilio/chat/event", bodyParser.json(), bodyParser.urlencoded({ extended: false }), async (req, res) => {
    res.send();
    try {

        if (req.body.EventType === "onUserUpdated") {
            let isOnline = req.body.IsOnline;
            let uid = req.body.Identity;
            let presence = await getUserPresence(uid);
            if (!presence) {
                presenceCache[uid] = undefined;
                return;
            }
            presence.set("isOnline", isOnline === 'true');
            presence.save({}, { useMasterKey: true });
        }
    } catch (err) {
        console.error(err);
    }
})
app.post("/twilio/bondedChannel/:masterChannelID/event", bodyParser.json(), bodyParser.urlencoded({ extended: false }), async (req, res) => {
    res.send();
    try {
        if (req.body.EventType === "onMessageSent") {
            //Re-broadcast this message to all of the channels bonded together
            console.log("Pushing message to bonded channels for " + req.params.masterChannelID)
            let allChannels = [];
            let bondQ = new Parse.Query(BondedChannel);
            bondQ.include("conference");
            let masterChan = await bondQ.get(req.params.masterChannelID, { useMasterKey: true });
            let childrenRelation = masterChan.relation("children");
            let childrenQ = childrenRelation.query();
            let mirrorChan = await childrenQ.find({ useMasterKey: true });
            allChannels = mirrorChan.map(c => c.get("sid"));
            allChannels.push(masterChan.get("masterSID"));
            allChannels = allChannels.filter(c => c !== req.body.ChannelSid);
            let conf = await getConferenceByID(masterChan.get("conference").id);
            for (let chan of allChannels) {
                conf.twilio.chat.services(conf.config.TWILIO_CHAT_SERVICE_SID).
                    channels(chan).messages.create({
                        from: req.body.From,
                        attributes: req.body.Attributes,
                        body: req.body.Body,
                        mediaSid: req.body.MediaSid
                    });
            }

        }

    } catch (err) {
        console.error(err);
    }
})

app.post("/twilio/event", bodyParser.json(), bodyParser.urlencoded({ extended: false }), async (req, res) => {
    res.send();
    try {
        await processTwilioEvent(req, res);
    } catch (e) {
        console.log(e);
    }
})

async function addOrReplaceConfig(installTo, key, value) {
    if (!installTo.config) {
        installTo.config = {};
    }
    let existingTokenQ = new Parse.Query(ClowdrInstance);
    existingTokenQ.equalTo("key", key);
    existingTokenQ.equalTo("instance", installTo);
    let tokenConfig = await existingTokenQ.first({}, { useMasterKey: true });
    if (!tokenConfig) {
        //Add the token
        tokenConfig = new InstanceConfig();
        tokenConfig.set("key", key);
        tokenConfig.set("instance", installTo);
    }
    installTo.config[key] = value;
    tokenConfig.set("value", value);
    let adminRole = await getOrCreateRole(installTo.id, "admin");

    let acl = new Parse.ACL();
    acl.setPublicReadAccess(false);
    acl.setPublicWriteAccess(false);
    acl.setRoleReadAccess(adminRole, true);
    acl.setRoleWriteAccess(adminRole, true);
    tokenConfig.setACL(acl, { useMasterKey: true });

    return tokenConfig.save({}, { useMasterKey: true });
}

async function getSession(token) {
    let query = new Parse.Query(Parse.Session);
    query.include("user");
    query.include("currentConference");
    query.equalTo("sessionToken", token);
    let session = await query.first({ useMasterKey: true });
    if (session) {
        return session;
    }
    return undefined;
}

app.post("/video/new", bodyParser.json(), bodyParser.urlencoded({ extended: false }), async (req, res) => {
    return await createNewRoom(req, res);
});

async function createNewRoom(req, res) {
    //Validate parse user can create this room
    let token = req.body.identity;
    // let conf = req.body.conf;
    // let confID = req.body.confid;
    let confID = req.body.conference;
    console.log("Create new room: Fetch conference")
    conf = await getConferenceByID(confID);
    if (!conf)
        console.log('Warn: Request did not include data to find the conference');

    console.log("Create new room: got conference")
    let roomName = req.body.room;
    let twilio = conf.twilio;
    let visibility = req.body.visibility;
    let category = req.body.category //TODO
    let mode = req.body.mode;
    let persistence = req.body.persistence;
    let socialSpaceID = req.body.socialSpace;
    if (!mode)
        mode = "group-small";
    if (!persistence)
        persistence = "ephemeral";


    try {
        let query = new Parse.Query(Parse.Session);
        // console.log(token);
        query.include("user");
        query.equalTo("sessionToken", token);
        let session = await query.first({ useMasterKey: true });
        console.log("Create new room: Got user from session token")
        if (session) {
            let parseUser = session.get("user");
            //Validate has privileges for conference
            const accesToConf = new Parse.Query(InstancePermission);
            accesToConf.equalTo("conference", conf);
            accesToConf.equalTo("action", privilegeRoles['createVideoRoom']);
            console.log('--> ' + JSON.stringify(privilegeRoles['createVideoRoom']));
            //TODO access-check for each option, too, but I don't have time now...
            const hasAccess = await accesToConf.first({ sessionToken: token });
            console.log('Permission to create video room? ' + hasAccess);
            if (hasAccess && hasAccess.id) {
                //Try to create the room
                try {
                    console.log("creating room with callback" + conf.config.TWILIO_CALLBACK_URL)
                    console.log("For " + parseUser.id + ": " + parseUser.get("displayname"))
                    console.log(roomName)
                    let maxParticipants = (mode === "peer-to-peer" ? 10 : (mode === "group-small" ? 4 : 10));
                    let twilioRoom = await twilio.video.rooms.create({
                        type: mode,
                        // type: conf.config.TWILIO_ROOM_TYPE,
                        uniqueName: roomName,
                        maxParticipants: maxParticipants,
                        statusCallback: conf.config.TWILIO_CALLBACK_URL
                    });
                    //Create a chat room too

                    let chat = twilio.chat.services(conf.config.TWILIO_CHAT_SERVICE_SID);


                    //Create a new room in the DB
                    let parseRoom = new BreakoutRoom();
                    parseRoom.set("title", roomName);
                    parseRoom.set("conference", conf);
                    parseRoom.set("twilioID", twilioRoom.sid);
                    parseRoom.set("isPrivate", visibility === "unlisted");
                    parseRoom.set("persistence", persistence);
                    parseRoom.set("mode", mode);
                    parseRoom.set("capacity", maxParticipants);
                    if (socialSpaceID) {
                        let socialSpace = new SocialSpace();
                        socialSpace.id = socialSpaceID;
                        parseRoom.set("socialSpace", socialSpace);
                    }
                    let modRole = await getOrCreateRole(conf.id, "moderator");

                    let acl = new Parse.ACL();
                    acl.setPublicReadAccess(false);
                    acl.setPublicWriteAccess(false);
                    acl.setRoleReadAccess(modRole, true);
                    if (visibility === "unlisted") {
                        acl.setReadAccess(parseUser.id, true);
                    }
                    else {
                        acl.setRoleReadAccess(await getOrCreateRole(conf.id, "conference"), true);
                    }
                    parseRoom.setACL(acl, { useMasterKey: true });
                    await parseRoom.save({}, { useMasterKey: true });
                    let attributes = {
                        category: "breakoutRoom",
                        roomID: parseRoom.id
                    }

                    let twilioChatRoom = await chat.channels.create({
                        friendlyName: roomName,
                        attributes: JSON.stringify(attributes),
                        type:
                            (visibility === "unlisted" ? "private" : "public")
                    });
                    if (visibility === "unlisted") {
                        //give this user access to the chat
                        let userProfile = await getUserProfile(parseUser.id, conf);
                        console.log("Creating chat room for " + roomName + " starting user " + userProfile.id)
                        await chat.channels(twilioChatRoom.sid).members.create({ identity: userProfile.id });
                        //Make sure that all moderators and admins have access to this room, too.
                        let modRole = await getOrCreateRole(conf.id, "moderator");
                        let userQuery = modRole.getUsers().query();
                        let profilesQuery = new Parse.Query(UserProfile);
                        profilesQuery.equalTo("conference", conf);
                        profilesQuery.matchesQuery("user", userQuery);
                        profilesQuery.find({ useMasterKey: true }).then((users) => {
                            for (let user of users) {
                                chat.channels(twilioChatRoom.sid).members.create({ identity: user.id });
                            }
                        })
                    }
                    parseRoom.set("twilioChatID", twilioChatRoom.sid);
                    await parseRoom.save({}, { useMasterKey: true });
                    sidToRoom[twilioRoom.sid] = parseRoom;
                    conf.rooms.push(parseRoom);
                    return res.send({ status: "OK" });
                } catch (err) {
                    console.error(err);
                    return res.send({
                        status: "error",
                        message: "There is already a video room with this name (although it may be private, and you can't see it). Please either join the existing room or pick a new name."
                    });
                }
            } else {
                return res.send({
                    status: "error",
                    message: "Sorry, you do not currently have access to create video rooms for " + conf.get("conferenceName")
                });
            }

        }
    } catch (err) {
        console.error(err);
        return res.send({ status: "error", message: "Internal server error " });
    }
    return res.send({
        status: "error",
        message: "Could not find enrollment for this user on this conference, " + conf
    });
}

async function removeFromCall(twilio, roomSID, identity) {
    console.log("Kick: " + identity);
    try {
        let participant = await twilio.video.rooms(roomSID).participants(identity).update({ status: 'disconnected' })
    } catch (err) {
        console.error(err);
        //might not be in room still.
    }
}
var uidToProfileCache = {};
async function getUserProfile(uid, conf) {

    let cacheKey = uid + "-" + conf.id;
    console.log(cacheKey)
    if (!uidToProfileCache[cacheKey]) {
        let uq = new Parse.Query(UserProfile);
        let fauxUser = new Parse.User();
        fauxUser.id = uid;
        uq.equalTo("user", fauxUser);
        uq.equalTo("conference", conf);
        let res = await uq.first({ useMasterKey: true });
        console.log(res);
        uidToProfileCache[cacheKey] = res;
    }
    return uidToProfileCache[cacheKey];
}
async function updateFollow(req, res) {
    try {
        let identity = req.body.identity;
        const roomID = req.body.roomID;
        const conference = req.body.conference;
        const users = req.body.users;
        const add = req.body.add;

        let conf = await getConferenceByID(conference);
        let userQ = new Parse.Query(Parse.Session);
        userQ.equalTo("sessionToken", identity);
        // let parseSession = await userQ.first({useMasterKey: true});
        // let parseUser = parseSession.get("user");
        let profileQ = new Parse.Query(UserProfile);
        profileQ.equalTo("conference", conf);
        profileQ.matchesKeyInQuery("user", "user", userQ);
        let profile = await profileQ.first({ useMasterKey: true });
        //Check for roles...
        let roomQ = new Parse.Query("BreakoutRoom");
        let room = await roomQ.get(roomID, { sessionToken: identity });
        if (!room) {
            return res.send({ status: 'error', message: "No such room" });
        }
        let watchers = room.get("watchers");
        if (!watchers)
            watchers = [];
        if (add)
            watchers.push(profile);
        else
            watchers = watchers.filter(p => p.id !== profile.id);
        room.set("watchers", watchers);
        await room.save({}, { useMasterKey: true });
        res.send({ status: "OK" });
    } catch (err) {
        console.error(err);
        res.send({ status: "error", message: "Internal server error" });
    }
}

async function updateACL(req, res) {
    try {
        let identity = req.body.identity;
        const roomID = req.body.roomID;
        const conference = req.body.conference;
        const users = req.body.users;
        let conf = await getConferenceByID(conference);
        let userQ = new Parse.Query(Parse.Session);
        userQ.equalTo("sessionToken", identity);
        userQ.include(["user.displayname"]);
        let parseSession = await userQ.first({ useMasterKey: true });
        let parseUser = parseSession.get("user");
        //Check for roles...
        let roomQ = new Parse.Query("BreakoutRoom");
        roomQ.include("conversation");
        let room = await roomQ.get(roomID, { sessionToken: identity });
        if (!room) {
            return res.send({ status: 'error', message: "No such room" });
        }
        let usersWithAccessCurrently = Object.keys(room.getACL().permissionsById).filter(v => !v.startsWith("role"));

        let chat = conf.twilio.chat.services(conf.config.TWILIO_CHAT_SERVICE_SID);

        let uq = new Parse.Query(Parse.User);
        let usersToRefresh = [];
        let promises = [];
        for (let uid of usersWithAccessCurrently) {
            let fauxUser = new Parse.User();
            fauxUser.id = uid;
            usersToRefresh.push(fauxUser);
            if (!users.includes(uid)) {
                room.getACL().setReadAccess(uid, false);
                let user = await uq.get(uid, { useMasterKey: true });
                //find the profile for this user, since that's what we want to put into twilio
                let userProfile = await getUserProfile(uid, conf);
                promises.push(removeFromCall(conf.twilio, room.get("twilioID"), userProfile.id));
                promises.push(chat.channels(room.get("twilioChatID")).members(userProfile.id).remove().catch(err => console.error(err)));
            }
        }
        for (let user of users) {
            if (!usersWithAccessCurrently.includes(user)) {

                if (room.get("conversation"))
                    room.get("conversation").getACL().setReadAccess(user, true);
                room.getACL().setReadAccess(user, true);
                let userProfile = await getUserProfile(user, conf);
                promises.push(chat.channels(room.get("twilioChatID")).members.create({ identity: userProfile.id }));
                let fauxUser = new Parse.User();
                fauxUser.id = user;
                usersToRefresh.push(fauxUser);
            }
        }
        if (room.get("conversation")) {
            await room.get("conversation").save({}, { useMasterKey: true });
        }
        if (users.length === 0) {
            await room.destroy({ useMasterKey: true });
        } else {
            await room.save({}, { useMasterKey: true });
        }
        await Promise.all(promises);

        promises = [];
        for (let user of usersToRefresh) {
            promises.push(pushToUserStream(user, conf, "privateBreakoutRooms"));
        }
        await Promise.all(promises);
        res.send({ status: "OK" });
    } catch (err) {
        console.error(err);
        res.send({ status: "error", message: "Internal server error" });
    }
}
async function getModeratorChannel(conf) {
    return conf.moderatorChannel;
}
async function sendModeratorMessage(req, res) {
    let identity = req.body.identity;
    const roomID = req.body.roomID;
    const conference = req.body.conference;
    const participants = req.body.participants;
    let conf = await getConferenceByID(conference);
    let userQ = new Parse.Query(Parse.Session);
    userQ.equalTo("sessionToken", identity);
    let parseSession = await userQ.first({ useMasterKey: true });
    let parseUser = parseSession.get("user");
    let profileQ = new Parse.Query(UserProfile);
    profileQ.equalTo("user", parseUser);
    profileQ.equalTo("conference", conf);
    let profile = await profileQ.first({ useMasterKey: true });
    //Check for roles...
    let roomQ = new Parse.Query("BreakoutRoom");
    let room = await roomQ.get(roomID, { sessionToken: identity });
    if (!room) {
        return res.send({ status: 'error', message: "No such room" });
    }
    let unfilledUsers = [];
    for (let id of participants) {
        unfilledUsers.push(UserProfile.createWithoutData(id));
    }
    let users = await Parse.Object.fetchAll(unfilledUsers, { useMasterKey: true });
    let usersString = "";
    for (let user of users) {
        usersString += user.get("displayName") + ", ";
    }
    if (usersString.length > 0) {
        usersString = usersString.substring(0, usersString.length - 2);
    }

    res.send({ status: "OK" });
}
app.post("/moderator/fromVideo", bodyParser.json(), bodyParser.urlencoded({ extended: false }), async (req, res) => {
    try {
        await sendModeratorMessage(req, res);
    } catch (err) {
        res.status(500);
        res.send({ status: "error", message: "An internal server error occurred." })
        console.error(err);
    }
})
app.post("/video/acl", bodyParser.json(), bodyParser.urlencoded({ extended: false }), async (req, res) => {
    await updateACL(req, res);
})
app.post("/video/follow", bodyParser.json(), bodyParser.urlencoded({ extended: false }), async (req, res) => {
    await updateFollow(req, res);
})
app.post("/video/token", bodyParser.json(), bodyParser.urlencoded({ extended: false }), async (req, res) => {
    try {
        await mintTokenForFrontend(req, res);
    } catch (err) {
        console.log("Not found when minting")
        console.error(err);
        res.status(500);
        res.send({ status: "error", message: "Internal server error" });
    }

});
async function createTwilioRoomForParseRoom(parseRoom, conf) {
    let twilioRoom = await conf.twilio.video.rooms.create({
        type: parseRoom.get("mode"),
        uniqueName: parseRoom.get("title"),
        statusCallback: conf.config.TWILIO_CALLBACK_URL
    });
    return twilioRoom;
}

async function mintTokenForFrontend(req, res) {
    let identity = req.body.identity;
    console.log("TOken requested by " + identity)
    const room = req.body.room;
    const conference = req.body.conference;
    let conf = await getConferenceByID(conference);
    if (!conf.config.TWILIO_ACCOUNT_SID) {
        res.status(403);
        console.log("Received invalid conference request: ");
        console.log(req.body);
        res.send({ status: "error", message: "Conference not configured." })
        return;
    }
    let userQ = new Parse.Query(Parse.Session);
    userQ.equalTo("sessionToken", identity);
    // userQ.include(["user.displayname"]);
    // console.log(identity)
    let parseSession = await userQ.first({ useMasterKey: true });
    let parseUser = parseSession.get("user");
    let userProfileQ = new Parse.Query(UserProfile);
    userProfileQ.equalTo("user", parseUser);
    userProfileQ.equalTo("conference", conf);
    let userProfile = await userProfileQ.first({ useMasterKey: true });
    identity = userProfile.id;

    // console.log("Get token for video for " + identity + " " + room)
    if (!room) {
        res.status(404);
        res.error();
    }
    let query = new Parse.Query("BreakoutRoom");
    let roomData = await query.get(room, { sessionToken: req.body.identity });
    if (!roomData.get("twilioID")) {
        if (roomData.get("persistence") === "persistent") {
            //Create a new twilio room
            try {
                let twilioRoom = await createTwilioRoomForParseRoom(roomData, conf);
                roomData.set("twilioID", twilioRoom.sid);
                await roomData.save({}, { useMasterKey: true });
                sidToRoom[twilioRoom.sid] = roomData;
            } catch (err) {
                //If an error ocurred making the twilio room, someone else must have updated it.
                console.error(err);
                let twilioRoom = await conf.twilio.video.rooms(roomData.get("title")).fetch();
                roomData.set("twilioID", twilioRoom.sid)
                await roomData.save({}, { useMasterKey: true });
                sidToRoom[twilioRoom.sid] = roomData;
            }
        } else {
            res.status(404);
            return res.send({ message: "This room has been deleted" });
        }
    }
    let newNode = {};
    if (!roomData) {
        res.status(403);
        res.error();
    }
    const token = videoToken(identity, roomData.get('twilioID'), conf.config);
    // console.log("Sent response" + token);
    sendTokenResponse(token, roomData.get('title'), res);

    // newNode[uid] = true;
    // let membersRef = roomRef.child("members").child(uid).set(true).then(() => {
    // });
}

app.post('/chat/token', bodyParser.json(), bodyParser.urlencoded({ extended: false }), async (req, res, next) => {
    const identity = req.body.identity;
    try {
        let sessionObj = await getSession(identity);
        if (!sessionObj) {
            res.status(403);
            res.send({ status: "Invalid token" })
            return;
        }
        console.log('[/chat/token]: conference: ' + JSON.stringify(req.body.conference));
        let conf = await getConferenceByID(req.body.conference);

        try {
            const accessToken = new AccessToken(conf.config.TWILIO_ACCOUNT_SID, conf.config.TWILIO_API_KEY, conf.config.TWILIO_API_SECRET,
                { ttl: 3600 * 24 });
            let userProfile = await getUserProfile(sessionObj.get("user").id, conf);
            let name = userProfile.id;
            let sessionID = sessionObj.id;
            let now = new Date().getTime();
            const chatGrant = new ChatGrant({
                serviceSid: conf.config.TWILIO_CHAT_SERVICE_SID,
                endpointId: `${name}:browser:${sessionID}:${now}`

            });
            accessToken.addGrant(chatGrant);
            accessToken.identity = name;
            res.set('Content-Type', 'application/json');
            res.send(JSON.stringify({
                token: accessToken.toJwt(),
                identity: name
            }));
        } catch (err) {
            res.send(JSON.stringify({ status: "Error", message: err }));
        }

    } catch (err) {
        next(err);
    }
    // newNode[uid] = true;
    // let membersRef = roomRef.child("members").child(uid).set(true).then(() => {
    // });
});
async function userInRoles(user, allowedRoles) {
    const roles = await new Parse.Query(Parse.Role).equalTo('users', user).find();
    return roles.find(r => allowedRoles.find(allowed => r.get("name") === allowed));
}
async function sessionTokenIsFromModerator(sessionToken, confID) {
    let session = await getSession(sessionToken);
    let user = session.get("user");
    return await userInRoles(user, [confID + "-moderator", confID + "-admin", confID + "-manager"]);
}
app.post('/chat/deleteMessage', bodyParser.json(), bodyParser.urlencoded({ extended: false }), async (req, res, next) => {
    const identity = req.body.identity;
    const messageSID = req.body.message;
    const channelSID = req.body.room;
    try {
        const hasAccess = await sessionTokenIsFromModerator(identity, req.body.conference);
        let conf = await getConferenceByID(req.body.conference);
        if (!hasAccess) {
            res.status(403);
            res.send();
            return;
        }
        let chat = await conf.twilio.chat.services(conf.config.TWILIO_CHAT_SERVICE_SID).channels(channelSID).messages(messageSID).remove();
        res.send({ status: "OK" });
    } catch (err) {
        next(err);
    }
    // newNode[uid] = true;
    // let membersRef = roomRef.child("members").child(uid).set(true).then(() => {
    // });
});

app.post('/video/deleteRoom', bodyParser.json(), bodyParser.urlencoded({ extended: false }), async (req, res, next) => {
    const identity = req.body.identity;
    const roomID = req.body.room;
    let conf = await getConferenceByID(req.body.conference);
    try {
        // const accesToConf = new Parse.Query(InstancePermission);
        // accesToConf.equalTo("conference", conf);
        // accesToConf.equalTo("action", privilegeRoles['moderator']);
        // const hasAccess = await accesToConf.first({sessionToken: identity});
        const hasAccess = await sessionTokenIsFromModerator(identity, conf.id);
        if (!hasAccess) {
            res.status(403);
            res.send();
            return;
        }
        //First, remove all users.
        let roomQ = new Parse.Query(BreakoutRoom);
        let room = await roomQ.get(roomID, { useMasterKey: true });
        if (!room) {
            console.log("Unable to find room:" + roomID)
        }
        let promises = [];
        if (room.get("members")) {
            for (let member of room.get("members")) {
                console.log("Kick: " + member.id);
                promises.push(removeFromCall(conf.twilio, room.get("twilioID"), member.id));
            }
        }
        await Promise.all(promises);
        await room.destroy({ useMasterKey: true });
        res.send({ status: "OK" });
    } catch (err) {
        next(err);
    }
    // newNode[uid] = true;
    // let membersRef = roomRef.child("members").child(uid).set(true).then(() => {
    // });
});


app.post('/users/ban', bodyParser.json(), bodyParser.urlencoded({ extended: false }), async (req, res, next) => {
    const identity = req.body.identity;
    const profileToBan = req.body.profileID;
    const isBan = req.body.isBan;
    let conf = await getConferenceByID(req.body.conference);
    try {
        // const accesToConf = new Parse.Query(InstancePermission);
        // accesToConf.equalTo("conference", conf);
        // accesToConf.equalTo("action", privilegeRoles['moderator']);
        const hasAccess = await sessionTokenIsFromModerator(identity, conf.id);
        if (!hasAccess) {
            res.status(403);
            res.send();
            return;
        }
        let profileQ = new Parse.Query(UserProfile);
        profileQ.include("user");
        let profile = await profileQ.get(profileToBan, { useMasterKey: true });
        if (isBan) {
            profile.set("isBanned", true);
            let bannedACL = new Parse.ACL();
            bannedACL.setWriteAccess(profile.get("user"), false);
            bannedACL.setRoleReadAccess(conf.id + "-conference", true);
            profile.setACL(bannedACL);
            await profile.save({}, { useMasterKey: true });

            //Deny user read access to their own record
            let user = profile.get("user");
            let bannedUserACL = new Parse.ACL();
            user.setACL(bannedUserACL);
            await user.save({}, { useMasterKey: true });
        } else {
            profile.set("isBanned", false);
            let notBannedACL = new Parse.ACL();
            notBannedACL.setWriteAccess(profile.get("user"), true);
            notBannedACL.setRoleReadAccess(conf.id + "-conference", true);

            profile.setACL(notBannedACL);
            await profile.save({}, { useMasterKey: true });
            let user = profile.get("user");

            let userACL = new Parse.ACL();
            userACL.setWriteAccess(user, true);
            userACL.setReadAccess(user, true);
            user.setACL(userACL);
            await user.save({}, { useMasterKey: true });

        }
        await pushToUserStream(profile.get("user"), conf, "profile");
        res.send({ status: "OK" });
    } catch (err) {
        res.status(500);
        console.error(err);
        res.send({ status: "error", message: "Internal server error, please check logs" })
    }
    // newNode[uid] = true;
    // let membersRef = roomRef.child("members").child(uid).set(true).then(() => {
    // });
});



// var parseLive = new Parse.LiveQueryClient({
//     applicationId: process.env.REACT_APP_PARSE_APP_ID,
//     serverURL: process.env.REACT_APP_PARSE_DOMAIN,
//     javascriptKey: process.env.REACT_APP_PARSE_JS_KEY,
// });
// parseLive.open();
// parseLive.on("error", (err) => {
//     console.error("Subscription error")
//     console.error(err);
// });
//At boot, we should still clear out our cache locally
async function runBackend() {
    let promises = [];

    let query = new Parse.Query("BreakoutRoom");
    query.limit(100);
    let rooms = await query.find({ useMasterKey: true });
    for (let room of rooms) {
        sidToRoom[room.get("twilioID")] = room;
    }

    await getPrivileges();

    if (!process.env.SKIP_INIT) {
        let query = new Parse.Query(ClowdrInstance);
        query.find({ useMasterKey: true }).then((instances) => {
            instances.forEach(
                async (inst) => {
                    try {
                        promises.push(getConferenceByID(inst.id).then((conf) => {
                            console.log("Finished " + conf.get("conferenceName"))
                        }).catch(err => {
                            console.log("Unable to load data for  " + inst.get("conferenceName"))
                            console.error(err);
                        }));
                    } catch (err) {
                        console.error(err);
                    }
                }
            )
        }).catch((err) => {
            console.error(err);
        });
    }
    Promise.all(promises).then(() => {
        app.listen(process.env.PORT || 3001, () =>
            console.log('Express server is running on localhost:3001')
        );
    });
}

runBackend();
