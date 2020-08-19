"use strict";
require('dotenv').config()

const Parse = require("parse/node");
const express = require('express');
const bodyParser = require('body-parser');
const moment = require("moment");
const {createEventAdapter} = require('@slack/events-api');
const {createMessageAdapter} = require('@slack/interactive-messages');
const {WebClient} = require('@slack/web-api');
var jwt = require('jsonwebtoken');
const crypto = require('crypto');


const slackEvents = createEventAdapter(process.env.SLACK_SIGNING_SECRET ? process.env.SLACK_SIGNING_SECRET : "");
const slackInteractions = createMessageAdapter(process.env.SLACK_SIGNING_SECRET ? process.env.SLACK_SIGNING_SECRET : "");

const {videoToken, ChatGrant, AccessToken} = require('./tokens');
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
app.use('/slack/events', slackEvents.expressMiddleware());

app.use('/slack/interaction', slackInteractions.expressMiddleware());
app.post('/slack/commands', bodyParser.urlencoded({extended: false}), slackSlashCommand);
const confCache = {};
const confIDToConf = {};
const userToAuthData = {};
const userToWorkspaces = {};
var sidToRoom = {};

let SlackHomeBlocks = Parse.Object.extend("SlackHomeBlocks");
let ClowdrInstance = Parse.Object.extend("ClowdrInstance");
let ClowdrInstanceAccess = Parse.Object.extend("ClowdrInstanceAccess");

let InstanceConfig = Parse.Object.extend("InstanceConfiguration");
let BreakoutRoom = Parse.Object.extend("BreakoutRoom");
let PrivilegedAction = Parse.Object.extend("PrivilegedAction");
var InstancePermission = Parse.Object.extend("InstancePermission");
let LiveActivity = Parse.Object.extend("LiveActivity");
let Channel = Parse.Object.extend("Channel");
let UserProfile = Parse.Object.extend("UserProfile");
let BondedChannel = Parse.Object.extend("BondedChannel");
let TwilioChannelMirror = Parse.Object.extend("TwilioChannelMirror");


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
    let rooms = await roomQuery.find({useMasterKey: true});
    return rooms;
}

var adminRole;

async function getParseAdminRole() {
    if (adminRole)
        return adminRole;
    let roleQ = new Parse.Query(Parse.Role);
    roleQ.equalTo("name", "ClowdrSysAdmin");
    adminRole = await roleQ.first({useMasterKey: true});
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
        let role = await roleQ.first({useMasterKey: true});
        if (!role) {
            let roleACL = new Parse.ACL();

            let adminRole = await getParseAdminRole();
            roleACL.setPublicReadAccess(true);
            let newrole = new Parse.Role(name, roleACL);
            newrole.getRoles().add(adminRole);
            try {
                newrole = await newrole.save({}, {useMasterKey: true});
            } catch (err) {
                console.log("Did not actually create it:")
                console.log(err);
            }
            roleCache[name] = newrole;
        } else {
            roleCache[name] = role;
        }
    } catch (err) {
        console.log("Unable to create role")
        console.log(err);
        return null;
    }
    return roleCache[name];
}

var emailsToParseUser;
var allUsersPromise;
var parseUIDToProfiles;

// slackEvents.on('team_join', async (event) => {
//     let conf = await getConference(event.user.team_id, "unknown");
//     if(conf.config.LOGIN_FROM_SLACK) {
//         const parseUser = await getOrCreateParseUser(event.user.id, conf, conf.config.slackClient);
//         console.log("Created parse user: " + parseUser.get("displayname") + " in " + conf.get("conferenceName"));
//     }
// });

// slackEvents.on('user_change', async (event) => {
//     let conf = await getConference(event.user.team_id, "unknown");
//     if(!conf.config.LOGIN_FROM_SLACK)
//         return;
//     let q = new Parse.Query(UserProfile);
//     q.equalTo("slackID", event.user.id);
//     q.equalTo("conference", conf);
//
//     let slackProfile = event.user;
//     let profile = await q.first({useMasterKey: true});
//     if (profile) {
//         if(profile.get("displayName") != slackProfile.real_name){
//             profile.set("displayName", slackProfile.real_name);
//             await profile.save({},{useMasterKey:true});
//         }
//     }
// });

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
            let {count, results} = await parseUserQ.find({useMasterKey: true});
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
                let results = await parseUserQ.find({useMasterKey: true});
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
        }catch(err){
            console.log("In get all users ")
            console.log(err);
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
            let {count, results} = await parseUserQ.find({useMasterKey: true});
            nRetrieved = results.length;
            // console.log(count);
            // console.log(results);
            results.map((u) => {
                if(!parseUIDToProfiles[u.get("user").id]){
                    parseUIDToProfiles[u.get("user").id] ={};
                }
                parseUIDToProfiles[u.get("user").id][u.get("conference").id] = u;
            });
            while (nRetrieved < count) {
                // totalCount = count;
                let parseUserQ = new Parse.Query(UserProfile);
                parseUserQ.limit(1000);
                parseUserQ.skip(nRetrieved);
                let results = await parseUserQ.find({useMasterKey: true});
                // results = dat.results;
                nRetrieved += results.length;
                if (results)
                    results.map((u) => {
                        if(!parseUIDToProfiles[u.get("user").id]){
                            parseUIDToProfiles[u.get("user").id] ={};
                        }
                        parseUIDToProfiles[u.get("user").id][u.get("conference").id] = u;
                    });
            }
            allUsersPromise = null;
            resolve(parseUIDToProfiles);
        }catch(err){
            console.log("In get all user profiles ")
            console.log(err);
            reject(err);
        }
    })
    allUsersPromise = Promise.all([usersPromise,profilesPromise]);
    return allUsersPromise;
}

async function addNewUsersFromSlack(conf) {
    try {
        let slackUsers = await conf.config.slackClient.users.list({limit: 1000});
        let allSlackMembers = slackUsers.members;
        while(slackUsers.response_metadata.next_cursor){
            slackUsers = await conf.config.slackClient.users.list({limit: 100, cursor: slackUsers.response_metadata.next_cursor})
            allSlackMembers = allSlackMembers.concat(slackUsers.members);
        }
        console.log(conf.get("conferenceName") + " fetched from slack: " + allSlackMembers.length)
        await getAllUsers();

        let confRole = await getOrCreateRole(conf.id, "conference");
        let existingQ = confRole.getUsers().query();
        existingQ.limit(1000)
        let existingUsers = await existingQ.find({useMasterKey: true});
        let roleUsersByID = {};
        existingUsers.map((u) => {
            roleUsersByID[u.id] = 1
        });

        // console.log("OK here's the list")
        // console.log(Object.keys(emailsToParseUser));
        // return;
        let promises = [];
        if (allSlackMembers) {
            for (let user of allSlackMembers) {
                let email = user.profile.email;
                let debug = false;
                if (email) {
                    if(email == "jon@clowdr.org"){
                        debug = true;
                    }
                    let parseUser = emailsToParseUser[email];
                    if (!parseUser || !parseUIDToProfiles[parseUser.id] || !parseUIDToProfiles[parseUser.id][conf.id]) {
                        promises.push(getOrCreateParseUser(user.id, conf, conf.config.slackClient, user).catch((e)=>{
console.log(e);
                       }));
                    } else {
                        let acl = parseUser.getACL();
                        if(acl.getPublicReadAccess())
                        {
                            acl.setPublicReadAccess(false);
                            await parseUser.save({},{useMasterKey: true});
                        }
                        //exists, just make sure that the role exists
                        if (!roleUsersByID[parseUser.id]) {
                            if(debug){
                                console.log("adding team role")
                            }
                            let confRole = await getOrCreateRole(conf.id, "conference");

                            promises.push(ensureUserHasTeamRole(parseUser, conf, confRole));
                            roleUsersByID[parseUser.id] = 1;
                        }
                        let profile = parseUIDToProfiles[parseUser.id][conf.id];
                        if(!profile.get("displayName") || user.profile.real_name != profile.get("displayName")){
                            console.log("Missing display name for " + profile.id)
                            profile.set("displayName",user.profile.real_name);
                            promises.push(profile.save({},{useMasterKey: true}));
                        }
                    }
                    // if(conf.get("conferenceName") == "PLDI 2020" && user.profile.status_emoji==":oc"){
                    //     promises.push(ensureUserHasTeamRole(parseUser, conf, confRole));
                    // }
                }
            }
        } else {
            console.log("No slack users found for " + conf.get('conferenceName'))
        }
        await Promise.all(promises).catch(err=>{
            console.log("While fetching users");
            console.log(err);
        });
        console.log("Finished updating accounts for " + conf.get("conferenceName"))
    } catch (err) {
        console.log(err);
    }
}


async function getConferenceByParseID(confID){
    if (confIDToConf[confID])
        return confIDToConf[confID];
    let q = new Parse.Query(ClowdrInstance);
    let conf = await q.get(confID, {useMasterKey: true});

    await initChatRooms(conf);
    confIDToConf[conf.id] = conf;

    return conf;
}

async function getConference(teamID, teamDomain) {
    if (!teamID)
        return;
    try {
        if (confCache[teamID])
            return confCache[teamID];

        let q = new Parse.Query(ClowdrInstance);
        let r = undefined;
        try {
            q.equalTo("slackWorkspace", teamID);
            r = await q.first();
        } catch (err) {
            console.log('[getConference]: err: ' + err);
        }
        // } catch (err) {
        if (!r) {
            console.log("Unable to find workspace in ClowdrDB: " + teamID + ", " + teamDomain);
        }

        await initChatRooms(r);

        confCache[teamID] = r;
        confIDToConf[r.id] = r;
        return r;
    } catch(err){
        console.log('[getConference]: outter err: ' + err);
        return null;
    }
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
            let newChatService = await r.twilio.chat.services.create({friendlyName: 'clowdr_chat'});
            await addOrReplaceConfig(r,"TWILIO_CHAT_SERVICE_SID", newChatService.sid);
        }

        let socialSpaceQ = new Parse.Query("SocialSpace");
        socialSpaceQ.equalTo("conference", r);
        socialSpaceQ.equalTo("name","Lobby");
        r.lobbySocialSpace = await socialSpaceQ.first({useMasterKey: true});

        //Make sure that there is a record of the instance for enrollments
        let accessQ = new Parse.Query(ClowdrInstanceAccess);
        accessQ.equalTo("instance", r);
        let accessRecord = await accessQ.first({useMasterKey: true});
        if (!accessRecord) {
            accessRecord = new ClowdrInstanceAccess();
            let role = await getOrCreateRole(r.id, "conference");
            let acl = new Parse.ACL();
            try {
                acl.setRoleReadAccess(r.id + "-conference", true);
                accessRecord.set("instance", r);
                accessRecord.setACL(acl);
                await accessRecord.save({}, {useMasterKey: true});
            } catch (err) {
                console.log("on room " + r.id)
                console.log(err);
            }
        }

        //This is the first time we hit this conference on this run, so we should also grab the state of the world from twilio

        let roomsInTwilio = await r.twilio.video.rooms.list();

        let modRole = await getOrCreateRole(r.id,"moderator");

        for (let room of roomsInTwilio) {
            if (room.status == 'in-progress') {
                if (r.rooms.filter((i) => i.get("twilioID") == room.sid).length == 0) {
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
                    parseRoom.setACL(acl, {useMasterKey: true});
                    await parseRoom.save({}, {useMasterKey: true});
                    sidToRoom[room.sid] = parseRoom;
                    r.rooms.push(parseRoom);
                }
            }
        }

        for (let parseRoom of r.rooms) {
            try {
                if (!parseRoom.get("twilioID") && parseRoom.get("persistence") != "ephemeral")
                    continue; //persistent room, not occupied.
                let found = roomsInTwilio.filter((i) => i.status == 'in-progress' && i.sid == parseRoom.get("twilioID"));
                if (found.length == 1 && found[0].status == 'in-progress') {
                    sidToRoom[parseRoom.get("twilioID")] = parseRoom;
                    //sync members
                    let participants = await r.twilio.video.rooms(parseRoom.get("twilioID")).participants.list();
                    for (let participant of participants) {
                        let uid = participant.identity;
                        let userFindQ = new Parse.Query(UserProfile);
                        try {
                            let user = await userFindQ.get(uid, {useMasterKey: true});
                            if (!parseRoom.get("members")) {
                                parseRoom.set("members", [user]);
                            } else {
                                if (parseRoom.get("members").filter((u) => u.id == uid).length == 0)
                                    parseRoom.get("members").push(user);
                            }
                        } catch (err) {
                            console.log("Missing participant: " + uid)
                            console.log(err);
                        }
                    }
                    let membersToRemove = [];
                    if (parseRoom.get("members")) {
                        for (let member of parseRoom.get("members")) {
                            let found = participants.filter((p) => {
                                let uid = p.identity;
                                return uid == member.id && p.status == "connected";
                            });
                            if (found.length == 0) {
                                //remove that member
                                membersToRemove.push(member.id);
                            }
                        }
                        let newMembers = parseRoom.get("members").filter((member) => !membersToRemove.includes(member.id));
                        parseRoom.set("members", newMembers);
                    }
                    await parseRoom.save({}, {useMasterKey: true});
                } else {
                    //room no logner exists
                    try {
                        if (parseRoom.get("persistence") == "persistent") {
                            parseRoom.set("twilioID", null);
                            await parseRoom.save({}, {useMasterKey: true});
                        } else {
                            if (parseRoom.get("twilioChatID")) {
                                await r.twilio.chat.services(r.config.TWILIO_CHAT_SERVICE_SID).channels(parseRoom.get("twilioChatID")).remove();
                            }
                            await parseRoom.destroy({useMasterKey: true});
                            r.rooms = r.rooms.filter((r) => r.id != parseRoom.id);
                        }
                    }catch(err){
                        console.log("Unable to delete " + parseRoom.id)
                        console.log(err);
                    }
                }
            } catch (err) {
                console.log("initialization error on " + parseRoom.id)
                console.log(err);
                console.log(err.stack)
            }
        }

        // if (!process.env.SKIP_INIT)
            // await addNewUsersFromSlack(r);

        let adminRole = await getParseAdminRole();
        let adminsQ = adminRole.getUsers().query();
        adminsQ.limit(1000);
        let admins = await adminsQ.find({useMasterKey: true});
        let promises = [];
        for (let admin of admins) {
            promises.push(ensureUserHasTeamRole(admin, r, await getOrCreateRole(r.id, "conference")));
        }

        //for twilio chat, make sure that there is a #general room
        let chatService = r.twilio.chat.services(r.config.TWILIO_CHAT_SERVICE_SID);
        // promises.push(chatService.channels.list().then((list) => {
        //         for (let chan of list) {
        //             if (chan.uniqueName != "#general") {
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
        //         if(chan.friendlyName == "#general")
        //             return;
        //         return chatService.channels("#general").update({uniqueName: "#general", friendlyName: "#general"}).then((chan)=>{
        //         }).catch(err=>{
        //             console.log("Unable to update channel")
        //             console.log(chan);
        //         });
        //     }).catch(err=>{
        //         console.log(err);
        //     })
        // )

        await Promise.all(promises).catch((err)=>{
            console.log(err);
        });

        try {
            if(r.config.slackClient) {
                let allChannels = await r.config.slackClient.conversations.list({types: "private_channel,public_channel"});

                for (let channel of allChannels.channels) {
                    if (channel.name == "moderators") {
                        r.moderatorChannel = channel.id;
                    } else if (channel.name == "technical-support") {
                        r.techSupportChannel = channel.id;
                    } else if (channel.name == "session-help") {
                        r.sessionHelpChannel = channel.id;
                    }
                }
            }
        } catch (err) {
            console.log('[getConference]: slack warn: ' + err);
        }
    } catch(err){
        console.log('[getConference]: outter err: ' + err);
    }
}

var userNotifications = {};

async function pushToUserStream(parseUser, parseConference, topic) {
    let activtyData;
    if (!userNotifications[parseUser.id] || !userNotifications[parseUser.id][parseConference.id] ||
        (topic && !userNotifications[parseUser.id][parseConference.id][topic])) {

        let liveActivityQ = new Parse.Query("LiveActivity");
        liveActivityQ.equalTo("user",parseUser);
        liveActivityQ.equalTo("conference", parseConference);
        liveActivityQ.equalTo("topic", topic);
        activtyData= await liveActivityQ.first({useMasterKey: true});
        if(!activtyData){
            activtyData = new LiveActivity();
            activtyData.set("user", parseUser);
            activtyData.set("conference", parseConference);
            activtyData.set("topic", topic);
            let acl = new Parse.ACL();
            acl.setPublicReadAccess(false);
            acl.setReadAccess(parseUser, true);
            activtyData.setACL(acl);
        }
        if(!userNotifications[parseUser.id])
            userNotifications[parseUser.id] ={};
        if(!userNotifications[parseUser.id][parseConference.id])
            userNotifications[parseUser.id][parseConference.id] = {};
        userNotifications[parseUser.id][parseConference.id][topic] = activtyData;
    } else {
        activtyData = userNotifications[parseUser.id][parseConference.id][topic];
    }
    await activtyData.save({}, {useMasterKey: true});

}
async function getConfig(conf) {
    let q = new Parse.Query(InstanceConfig)
    q.equalTo("instance", conf);
    let res = await q.find({useMasterKey: true});
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
    if(config.LOGIN_FROM_SLACK == "false")
    {
        config.LOGIN_FROM_SLACK = false;
    }
    else{
        config.LOGIN_FROM_SLACK = true;
    }
    // config.TWILIO_CALLBACK_URL = "https://clowdr-dev.ngrok.io/twilio/event";
    if(config.SLACK_BOT_TOKEN)
        config.slackClient = new WebClient(config.SLACK_BOT_TOKEN);

    // console.log(JSON.stringify(config,null,2))
    return config;
}

var userIDToSession = {};
var parseRoomCache = {};
async function pushActiveCallsFromConfToBlocks(conf, blocks, parseUser, teamID) {

    let sessionToken = userIDToSession[parseUser.id];
    if(!sessionToken){
        let userQ = new Parse.Query(Parse.Session);
        userQ.equalTo("user", parseUser);
        let parseSession = await userQ.first({useMasterKey: true});
        sessionToken = parseSession.getSessionToken();
        userIDToSession[parseUser.id] = sessionToken;
    }
    let techSupportRoom = conf.techSupportChannel;

    const accesToConf = new Parse.Query(InstancePermission);
    accesToConf.equalTo("conference", conf);
    accesToConf.equalTo("action", privilegeRoles['access-from-slack']);
    const hasAccess = await accesToConf.first({sessionToken: sessionToken});
    if (!hasAccess) {
        console.log("User: " + parseUser.id)
        console.log("Session:" + sessionToken)
        blocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: "Sorry, this feature is not yet enabled."
            }
        })
        return;
    }

    let query = new Parse.Query(BreakoutRoom);
    query.include("members");
    query.equalTo("conference", conf);
    query.limit(100);
    let rooms = await query.find({sessionToken: sessionToken});

    let lobbyQ = new Parse.Query("UserPresence")
    lobbyQ.equalTo("socialSpace", conf.lobbySocialSpace);
    let lobby = await lobbyQ.find({sessionToken: sessionToken});

    if (rooms.length == 0) {
        blocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: "Nobody is in a video call yet. To create a new room, create a new message `/video [name of room to join or create]`"
            }
        })
        return;
    }
    blocks.push({
        type: "section",
        text: {
            type: "mrkdwn",
            text: rooms.length + " video room" + (rooms.length > 1 ? 's are' : ' is') + " up right now (this list includes all public rooms and all private rooms to which you have access). " +
                "Join one of these, or create a new room by sending a new message `/video [name of room to join or create]`"
        }
    })
    for (let room of rooms) {
        let membersString = "";
        if (room.get("members")) {
            for (let member of room.get("members")) {
                if (member.get("slackID"))
                    membersString += "<@" + member.get("slackID") + ">,"
            }
        }
        if (membersString.length > 0) {
            membersString = membersString.substring(0, membersString.length - 1);
        } else {
            membersString = "(Empty)"
        }
        let joinAccy;

        const link = await buildLink(room.id, room.get("title"), parseUser, conf, teamID);
        // joinAccy = {
        //     type: "button",
        //     action_id: "join_video",
        //     value: room.id,
        //     url: link,
        //     text: {
        //         type: "plain_text",
        //         text: "Join Video"
        //     }
        // }
        let block = {
            type: "section",
            text: {
                type: "mrkdwn",
                text: "<"+link+"|"+room.get("title") + ">: " + membersString,
            },
            // accessory: joinAccy
        }
        blocks.push(block);
    }
    const lobbyLink = await buildLink(null, null, parseUser, conf ,teamID);
    blocks.push({type: "section",
    text:{
        type: "mrkdwn",
        text: "Or, join the "+lobby.length+" users hanging out <"+lobbyLink+"|in the lobby>"
    }});
    let msg = "If you are on mobile, please be sure to open this in a real browser (e.g. not in the embedded slack browser). We have tested support for Safari, Firefox, Chrome and Edge." + (techSupportRoom ? "Having trouble with technical issues? Come join <#"+techSupportRoom+">.":"")
    blocks.push({
        type: "section", text: {
            type: "mrkdwn",
            text: msg

        },
    })
    // console.log(JSON.stringify(blocks, null, 2));
}

async function ensureUserHasTeamRole(user, conf, role) {
    let confID = conf.id;
    // console.trace()
    if (userToWorkspaces[user.id] && userToWorkspaces[user.id][conf.id]) {
        return;
    }
    let debug =false;
    try {
        //Check in DB
        const roleQuery = new Parse.Query(Parse.Role);
        roleQuery.equalTo("users", user);
        roleQuery.equalTo("id", role.id);
        if(!role.id){
            console.log("invalid role?")
            console.log(role);
            console.trace();
        }
        const roles = await roleQuery.find({useMasterKey: true});
        if (!roles || roles.length == 0) {
            role.getUsers().add(user);
            let savedRole= await role.save(null, {useMasterKey: true, cascadeSave: true});
        }else if(debug){
            console.log("Already has role? "+ user.id)
        }
        if (!userToWorkspaces[user.id]) {
            userToWorkspaces[user.id] = {};
        }
        userToWorkspaces[user.id][conf.id] = 1;
    }catch(err){
        console.log("Error in role")
        console.log(err);
    }
}

var privilegeRoles = {
    "createVideoRoom": null,
    "chat": null,
    "access-from-slack": null,
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
    let pactions = await actionsQ.find({useMasterKey: true});
    console.log("Get privileges: " + pactions ? pactions.length : 0);

    Object.keys(privilegeRoles).map(actionName => {
        let action = pactions.find(act => act.get("action") == actionName);
        if (action) {
            privilegeRoles[actionName] = action;
        }
    });
}

async function getOrCreateParseUser(slackUID, conf, slackClient, slackProfile) {
    //First try retrieving by slack ID
    let q = new Parse.Query(UserProfile);
    q.equalTo("slackID", slackUID);
    q.equalTo("conference", conf);
    q.include("user");

    let profile = await q.first({useMasterKey: true});
    console.log("Get or create slack user for " + slackUID)
    if (profile) {
        console.log("Found profile: " + profile.id + " for " + slackUID + ", user id "+ profile.get("user").id)
        let uq = new Parse.Query(Parse.User);
        let user = await uq.get(profile.get("user").id,{useMasterKey: true});
        await ensureUserHasTeamRole(user, conf, await getOrCreateRole(conf.id, "conference"));
        if(!profile.get("displayName")){
            if(user.get("displayname")){
                console.log("Set to " + user.get("displayname"));
                profile.set("displayName", user.get("displayname"));
                await profile.save(null,{useMasterKey: true});
            }
            console.log("Missing ID: " + profile.id + " now " + profile.get("displayName"))
        }
        return profile.get("user");
    }
    //Now try to retrieve by email

    try {
        let user_info = await slackClient.users.info({user: slackUID});
        q = new Parse.Query(Parse.User);
        q.equalTo("email", user_info.user.profile.email);
        let u = await q.first({useMasterKey: true});
        if (u) {
            //Just create the profile
            console.log("Creating profile " + slackUID);
            let profile = new UserProfile();
            profile.set("user", u);
            profile.set("conference", conf);
            profile.set("slackID", slackUID);
            profile.set("displayName", user_info.real_name);
            let profileACL = new Parse.ACL();
            profileACL.setRoleReadAccess(await getOrCreateRole(conf.id,"conference"), true);
            profileACL.setWriteAccess(u, true);
            profile.setACL(profileACL);

            await profile.save({}, {useMasterKey: true});
            await ensureUserHasTeamRole(u, conf, await getOrCreateRole(conf.id, "conference"));
            u.get("profiles").add(profile);
            await u.save({}, {useMasterKey: true});
            return u;
        }
        let user = await createParseUserAndEnsureRole(user_info.user, conf, await getOrCreateRole(conf.id, "conference"));
        let profile = new UserProfile();
        profile.set("user", user);
        profile.set("conference", conf);
        profile.set("slackID", slackUID);
        profile.set("displayName", user.get("displayname"));
        let profileACL = new Parse.ACL();
        profileACL.setRoleReadAccess(await getOrCreateRole(conf.id,"conference"), true);
        profileACL.setWriteAccess(user, true);
        profile.setACL(profileACL);
        profile = await profile.save({}, {useMasterKey: true});
        let relation = user.relation("profiles");
        relation.add(profile);

        let userACL = new Parse.ACL();
        userACL.setWriteAccess(user, true);
        userACL.setReadAccess(user, true);
        user.setACL(userACL);
        await user.save({}, {useMasterKey: true});
        return user;
    } catch (err) {
        console.log("Unable to create user "+ slackUID)
        console.log(err);
        return null;
    }
}

async function createParseUserAndEnsureRole(slackUser, conf, role) {
    //Fallback. Create a new user in parse to represent this person.
    let user = new Parse.User();
    user.set("username", slackUser.profile.email);
    user.set("displayname", slackUser.profile.real_name);
    user.set("password", slackUser.profile.email + Math.random());
    user.set("email", slackUser.profile.email);
    user = await user.signUp({}, {useMasterKey: true});
    await ensureUserHasTeamRole(user, conf, role);
    let userACL = new Parse.ACL();
    userACL.setWriteAccess(user, true);
    userACL.setReadAccess(user, true);
    userACL.setRoleReadAccess("moderators", true);
    userACL.setPublicReadAccess(false);
    user.setACL(userACL);
    await user.save({},{useMasterKey: true})
    return user;
}

async function generateHome(conf, parseUser, teamID) {
    let q = new Parse.Query(SlackHomeBlocks);
    q.equalTo("conference", conf);
    q.addAscending("sortKey");
    let dbBlocks = await q.find({useMasterKey: true});
    let blocks = [];

    for (let b of dbBlocks) {
        blocks.push({
            type: "section",
            text: {
                type: b.get('type'),
                text: b.get('content')
            }
        })
    }
    blocks.push({
        type: 'divider'
    });

    await pushActiveCallsFromConfToBlocks(conf, blocks, parseUser, teamID);

    let view = {
        type: 'home',
        title: {
            type: 'plain_text',
            text: conf.get("conferenceName") + " LIVE @CLOWDR"
        },
        blocks: blocks
    }
    // console.log(view.title.text);
    return view;
}

async function buildLink(roomID, roomName, parseUser, conf, teamID) {

    let link = conf.config.FRONTEND_URL;
    if (link.endsWith('/'))
        link = link.substring(0, link.length - 1);
    if (!userToAuthData[parseUser.id]) {
        let secret = await generateRandomString(48);
        userToAuthData[parseUser.id] = secret;
        parseUser.set("loginKey", secret);
        parseUser.set("loginExpires", moment().add("8", "hours").toDate());
        await parseUser.save({}, {useMasterKey: true});
    }
    let token = jwt.sign({
        uid: parseUser.id,
        team: teamID,
        secret: userToAuthData[parseUser.id],
        roomName: roomName,
    }, process.env.CLOWDR_JWT_KEY, {expiresIn: '8h'});

    link = link + '/fromSlack/' + encodeURI(teamID) + '/' +
        encodeURI(token);
    return link;
}

function respondWithError(response_url, error) {
    const message = {
        "text": error,
        "response_type": "ephemeral",
    };

    return axios.post(response_url, message
    ).catch(console.error);
}

function sendMessageWithLinkToUser(response_url, messageText,conf, linkText, link) {
    let techSupportRoom = conf.techSupportChannel;
    const message = {
        "text": messageText, //+". <"+link+"|"+linkText+">",
        "response_type": "ephemeral",
        // Block Kit Builder - http://j.mp/bolt-starter-msg-json
        "blocks": [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": messageText + (link ? " <" + link + "|" + linkText + ">" : ""),
                }
            },
        ],
        "attachments": [{
            "text": (link?"If you are on mobile, please be sure to open this in a real browser (e.g. not in the embedded slack browser). We have tested support for Safari, Firefox, Chrome and Edge." : "")+ (techSupportRoom ? "Having trouble with technical issues? Come join <#"+techSupportRoom+">.":"")
        }]
    };
    if(link){
        // message.blocks.push(  {
        //     "type": "actions",
        //     "block_id": "actions1",
        //     "elements": [
        //
        //         {
        //             "type": "button",
        //             "text": {
        //                 "type": "plain_text",
        //                 "text": linkText
        //             },
        //             "action_id": "join_call_clicked",
        //             "value": "click_me_123",
        //             "url": link
        //         }]
        // });
    }

    return axios.post(response_url, message);
}

async function sendSessionHelpMessageFromSlack(conf, slackUID, message){
    let slack = conf.config.slackClient;
    let channel = conf.sessionHelpChannel;
    await conf.config.slackClient.chat.postMessage({channel: channel,
        text: "Urgent session help request from slack",
        blocks:[
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "A session help request was received from <@"+slackUID+"> in slack:"
                }
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": ">"+message
                }
            }
        ]
    })


}

async function sendModeratorMessageFromSlack(conf, slackUID, message){
    let slack = conf.config.slackClient;
    let channel = await getModeratorChannel(conf);
    await conf.config.slackClient.chat.postMessage({channel: channel,
        text: "Moderation request from slack",
        blocks:[
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "A moderation request was received from <@"+slackUID+"> in slack:"
                }
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": ">"+message
                }
            }
        ]
    })


}
async function sendJoinLinkToUser(body, roomName, isPrivate) {
    if (!roomName) {
        respondWithError(body.response_url, "You need to specify a room name");
        return;
    }
    if (roomName.startsWith("!")) {
        respondWithError(body.response_url, "Room names can not begin with special characters")
        return;
    }
    let conf = await getConference(body.team_id, body.team_domain)
    let slackClient = conf.config.slackClient;
    const parseUser = await getOrCreateParseUser(body.user_id, conf, slackClient);

    //Make sure that the user has access...
    let sessionToken = userIDToSession[parseUser.id];
    if(!sessionToken){
        let userQ = new Parse.Query(Parse.Session);
        userQ.equalTo("user", parseUser);
        let parseSession = await userQ.first({useMasterKey: true});
        sessionToken = parseSession.getSessionToken();
        userIDToSession[parseUser.id] = sessionToken;
    }

    const accesToConf = new Parse.Query(InstancePermission);
    accesToConf.equalTo("conference", conf);
    accesToConf.equalTo("action", privilegeRoles['access-from-slack']);
    const hasAccess = await accesToConf.first({sessionToken: sessionToken});
    if(!hasAccess){
        respondWithError(body.response_url,"You do not currently have access to video rooms at " + conf.get("conferenceName"));
        return;
    }

    const link = await buildLink(null, roomName, parseUser, conf, body.team_id);
    await sendMessageWithLinkToUser(body.response_url, "Finish creating or joining the live video call '" + roomName + "' in our web app! :tv: Remember to keep Slack open too to keep the conversation going here!", conf, "Start Video Room", link);

}

slackInteractions.action({action_id: "join_video"}, async (payload, respond) => {

    await respond({});

    return {}
});

// slackEvents.on("app_home_opened", async (payload) => {
//     if (!payload.view)
//         return;
//     let team_id = payload.view.team_id;
//     let conf = await getConference(team_id)
//     // console.log(conf);
//
//     const parseUser = await getOrCreateParseUser(payload.user, conf, conf.slackClient);
//     const args = {
//         token: conf.config.SLACK_BOT_TOKEN,
//         user_id: payload.user,
//         view: await generateHome(conf, parseUser, payload.view.team_id)
//     };
//
//     const result = await axios.post('https://slack.com/api/views.publish', JSON.stringify(args), {
//         headers: {
//             "Authorization": "Bearer " + conf.config.SLACK_BOT_TOKEN,
//             'Content-Type': 'application/json'
//         }
//     });
// });

// async function sendLoginLinkToUser(conf, body){
//     const parseUser = await getOrCreateParseUser(body.user_id, conf, conf.config.slackClient);
//     let secret = await generateRandomString(48);
//     let token = jwt.sign({
//         identity: body.user_id,
//         team: conf.id,
//         secret: secret
//     }, process.env.CLOWDR_JWT_KEY, {expiresIn: '10m'});
//     try {
//         let myAuthData ={id: secret,
//         user: body.user_id};
//
//         // let link = conf.config.FRONTEND_URL;
//         // if (link.endsWith('/'))
//         //     link = link.substring(0, link.length - 1);
//         let link = "http://localhost:3000/slack"
//         link = link + "/login/" + encodeURI(body.user_id) + "/" + encodeURI(secret);
//         await sendMessageWithLinkToUser(body.response_url, "Almost there! Just one more step to be logged in to live.clowdr.org:", "Login", link);
//     } catch (err) {
//         console.log(err);
//     }
//
//
// }


async function slackSlashCommand(req, res, next) {
    let teamID = req.body.team_id;
    res.status(200).end();
    let conf = await getConference(req.body.team_id, req.body.team_domain)
    console.log(conf.id)
    console.log(req.body.user_id)
    //
    // if(req.body.command == "/login"){
    //     res.send();
    //     console.log(req.body);
    //     await sendLoginLinkToUser(conf, req.body);
    // }
    // if(req.body.command === "/saysomething" || req.body.command == "/moderator"){
    //     try {
    //         await sendModeratorMessageFromSlack(conf, req.body.user_id, req.body.text)
    //         sendMessageWithLinkToUser(req.body.response_url,"Your message has been received by the moderators. They will contact you ASAP to follow up. " +
    //             " Please note that since moderators are volunteers, we are unable to provide a 24/7 moderation service," +
    //             " but will do our best to address every complaint as quickly as possible." //, and will be sure to follow up" +
    //             // " to every report."
    //                 , conf)
    //     }catch(err){
    //         console.log(err);
    //         sendMessageWithLinkToUser(req.body.response_url, "An internal error occurred while sending your message. Please try again or email the organizers. ", conf);
    //
    //     }
    //
    //     return;
    // }
    // if(req.body.command === "/sessionhelp"){
    //     try {
    //         await sendSessionHelpMessageFromSlack(conf, req.body.user_id, req.body.text)
    //         sendMessageWithLinkToUser(req.body.response_url,"Your message has been received by the organizers. You should receive a direct message via slack ASAP."
    //             , conf)
    //     }catch(err){
    //         console.log(err);
    //         sendMessageWithLinkToUser(req.body.response_url, "An internal error occurred while sending your message. Please try again or email the organizers. ", conf);
    //
    //     }
    //
    //     return;
    // }
    // if(req.body.command == "/gather"){
    //     if(conf.config.GATHER_LINK)
    //     {
    //         const message = {
    //             "text": "Join the virtual space in Gather: "+conf.config.GATHER_LINK + ". Please note that Gather supports only Firefox and Chrome",
    //             "response_type": "ephemeral",
    //             // Block Kit Builder - http://j.mp/bolt-starter-msg-json
    //             "blocks": [
    //                 {
    //                     "type": "section",
    //                     "text": {
    //                         "type": "mrkdwn",
    //                         "text": "Join the virtual space in Gather: "+conf.config.GATHER_LINK + ". Please note that Gather supports only Firefox and Chrome",
    //                     }
    //                 },
    //                 {
    //                     "type": "section",
    //                     "text": {
    //                         "type": "mrkdwn",
    //                         "text": "Gather has multiple maps that you can explore, <https://www.doc.ic.ac.uk/~afd/pldi-beach-minimap.jpg|like this entrance area and beach>."
    //                     },
    //                     "accessory": {
    //                         "type": "image",
    //                         "image_url": "https://www.doc.ic.ac.uk/~afd/pldi-beach-minimap.jpg",
    //                         "alt_text": "Gather map"
    //                     }
    //                 },
    //                 {
    //                     "type": "section",
    //                     "text": {
    //                         "type": "mrkdwn",
    //                         "text": "The <https://www.doc.ic.ac.uk/~afd/pldi-minimap.jpg|virtual poster session and sponsor booths> also have their own room in Gather."
    //                     },
    //                     "accessory": {
    //                         "type": "image",
    //                         "image_url": "https://www.doc.ic.ac.uk/~afd/pldi-minimap.jpg",
    //                         "alt_text": "Another Gather map"
    //                     }
    //                 }
    //             ],
    //         };
    //         return axios.post(req.body.response_url, message);
    //         // sendMessageWithLinkToUser(req.body.response_url,"Join the virtual space in Gather: "+conf.config.GATHER_LINK + ". Please note that Gather supports only Firefox and Chrome", conf);
    //     }
    //     else{
    //         sendMessageWithLinkToUser(req.body.response_url,"This feature is not enabled on this slack workspace.", conf);
    //     }
    //     return
    // }
    // if(req.body.command === "/videodebug"){
    //     req.body.command = "/video";
    //     // return;
    //
    //
    // }
    // if (req.body.command === '/video_t' || req.body.command === '/video' || req.body.command === '/videoprivate' || req.body.command == "/videolist") {
    //     res.send();
    //     if(!conf.config.LOGIN_FROM_SLACK){
    //         respondWithError(req.body.response_url, "Access video by logging in at " + conf.config.FRONTEND_URL);
    //         return;
    //     }
    //
    //     try {
    //         if (req.body.text) {
    //             await sendJoinLinkToUser(req.body, req.body.text, (req.body.command === "/videoprivate"));
    //         } else {
    //             const parseUser = await getOrCreateParseUser(req.body.user_id, conf, conf.config.slackClient);
    //             let blocks = [];
    //
    //             await pushActiveCallsFromConfToBlocks(conf, blocks, parseUser, req.body.team_id);
    //             const message = {
    //                 "text": "Live video information",
    //                 "response_type": "ephemeral",
    //                 // Block Kit Builder - http://j.mp/bolt-starter-msg-json
    //                 "blocks": blocks
    //             };
    //
    //
    //             await axios.post(req.body.response_url, message
    //             ).catch(console.error);
    //         }
    //     } catch (err) {
    //         console.log("Error procesing command")
    //         console.log(err);
    //     }
    // } else {
    //     next();
    // }
}

async function processTwilioEvent(req, res) {
    let roomSID = req.body.RoomSid;
    console.log("Twilio event: "+ req.body.StatusCallbackEvent + " " + req.body.RoomSid)
    try {
        // let room = sidToRoom[roomSID];
        if (req.body.StatusCallbackEvent == 'participant-connected') {

            let roomQ = new Parse.Query(BreakoutRoom);
            roomQ.equalTo("twilioID", roomSID);
            let room = await roomQ.first({useMasterKey: true});

            let uid = req.body.ParticipantIdentity;
            let userFindQ = new Parse.Query(UserProfile);
            let user = await userFindQ.get(uid, {useMasterKey: true});
            if (!room.get("members")) {
                room.set("members", [user]);
            } else {
                if (room.get("members").filter((u) => u.id == uid).length == 0)
                    room.get("members").push(user);
            }
            await room.save({}, {useMasterKey: true});

            // let newUser = await roomsRef.child(req.body.RoomName).child("members").child(uid).set(true);
            // console.log("Added " + req.body.ParticipantIdentity + " to " + roomDBID + " count is now " + membersCache[roomDBID]);
            // ;
            // membersCache[req.body.RoomName]++;
        } else if (req.body.StatusCallbackEvent == 'participant-disconnected') {
            let roomQ = new Parse.Query(BreakoutRoom);
            roomQ.equalTo("twilioID", roomSID);
            let room = await roomQ.first({useMasterKey: true});

            let uid = req.body.ParticipantIdentity;
            let userFindQ = new Parse.Query(User);
            if (!room.get("members")) {
                room.set("members", []);
            } else {
                room.set("members", room.get("members").filter((u) => u.id != uid));
            }
            await room.save({}, {useMasterKey: true});

            // } else if(req.body.StatusCallbackEvent == '')
        } else if (req.body.StatusCallbackEvent == 'room-ended') {
            let roomQ = new Parse.Query(BreakoutRoom);
            roomQ.equalTo("twilioID", roomSID);
            let room = await roomQ.first({useMasterKey: true});
            if (room) {
                if (room.get("persistence") == "persistent") {
                    console.log("Removing tid " + room.get("title"))
                    room.set("twilioID", null);
                    await room.save({}, {useMasterKey: true});
                } else {
                    if(room.get("twilioChatID")){
                        //get the twilio client for this room to delete the chat room
                        // let confID = room.get("conference").id
                        // let conf = await getConferenceByParseID(confID);
                        // await conf.twilio.chat.services(conf.config.TWILIO_CHAT_SERVICE_SID).
                        // channels(room.get("twilioChatID")).remove();
                    }
                    await room.destroy({useMasterKey: true});
                }
            } else {
                console.log("unable to destroy " + roomSID);
            }
        } else {
        }
    } catch
        (err) {
        console.log(err);
        // next(err);

    }
    console.log("DONE Twilio event: "+ req.body.StatusCallbackEvent + " " + req.body.RoomSid)

    res.send();
}

var presenceCache = {};

function getUserPresence(profileID) {
    if (!presenceCache[profileID]) {
        let presenceQ = new Parse.Query("UserPresence");
        let prof = new UserProfile();
        prof.id = profileID;
        presenceQ.equalTo("user", prof);
        presenceCache[profileID] = presenceQ.first({useMasterKey: true});
    }
    return presenceCache[profileID];
}

app.post("/webhook/zoom/participant", bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res) => {
    res.send();
    try {
        let meeting_id = req.body.payload.id;
        if(req.body.payload.object && req.body.payload.object.participant)
        {
            let registrant_id = req.body.payload.object.participant.id;
            console.log(req.body.event+"\t"+registrant_id)
            console.log(req.body)
            console.log(req.body.payload.object.participant)
            if(req.body.event == "meeting_participant_joined"){

            }else if(req.body.event == "meeting_participant_left"){

            }
        }
    }catch(err){
        console.log(err);
    }
})


app.post("/twilio/chat/event", bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res) => {
    res.send();
    try {

        if (req.body.EventType == "onUserUpdated") {
            let isOnline = req.body.IsOnline;
            let uid = req.body.Identity;
            let presence = await getUserPresence(uid);
            if(!presence){
                presenceCache[uid] = undefined;
                return;
            }
            presence.set("isOnline", isOnline == 'true');
            presence.save({}, {useMasterKey: true});
        }
    }catch(err){
        console.log(err);
    }
})
app.post("/twilio/bondedChannel/:masterChannelID/event", bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res) => {
    res.send();
    try {
        if(req.body.EventType == "onMessageSent"){
            //Re-broadcast this message to all of the channels bonded together
            console.log("Pushing message to bonded channels for " + req.params.masterChannelID)
            let allChannels = [];
            let bondQ = new Parse.Query(BondedChannel);
            bondQ.include("conference");
            let masterChan = await bondQ.get(req.params.masterChannelID, {useMasterKey:true});
            let childrenRelation = masterChan.relation("children");
            let childrenQ = childrenRelation.query();
            let mirrorChan = await childrenQ.find({useMasterKey: true});
            allChannels = mirrorChan.map(c => c.get("sid"));
            allChannels.push(masterChan.get("masterSID"));
            allChannels = allChannels.filter(c=>c!=req.body.ChannelSid);
            let conf = await getConference(masterChan.get("conference").get("slackWorkspace"));
            for(let chan of allChannels){
                conf.twilio.chat.services(conf.config.TWILIO_CHAT_SERVICE_SID).
                    channels(chan).messages.create({
                   from: req.body.From,
                   attributes: req.body.Attributes,
                   body: req.body.Body,
                   mediaSid: req.body.MediaSid
                });
            }

        }

    }catch(err){
        console.log(err);
    }
})

app.post("/twilio/event", bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res) => {
    res.send();
    try {
        await processTwilioEvent(req, res);
    }catch (e) {
        console.log(e);
    }
})

async function addOrReplaceConfig(installTo, key, value) {
    if(!installTo.config){
        installTo.config = {};
    }
    let existingTokenQ = new Parse.Query(ClowdrInstance);
    existingTokenQ.equalTo("key", key);
    existingTokenQ.equalTo("instance", installTo);
    let tokenConfig = await existingTokenQ.first({}, {useMasterKey: true});
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
    tokenConfig.setACL(acl, {useMasterKey: true});

    return tokenConfig.save({}, {useMasterKey: true});
}

app.get("/slack/auth", async (req, res) => {

    axios.post("https://slack.com/api/oauth.v2.access", qs.stringify({
        client_id: process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code: req.query.code
    })).then(async (resp) => {
        console.log("Signup:")
        console.log(resp.data);
        // console.log(req.query.code);
        if (!resp.data.ok) {
            return res.send(403, resp.data);
        }
        let q = new Parse.Query(ClowdrInstance);
        q.equalTo("pendingWorkspaceName", resp.data.team.name);
        let q2 = new Parse.Query(ClowdrInstance);
        q2.equalTo("slackWorkspace", resp.data.team.id);
        let mainQ = Parse.Query.or(q, q2);
        let installTo = await mainQ.first({useMasterKey: true});
        if (!installTo) {
            installTo = new ClowdrInstance();
            installTo.set("slackWorkspace", resp.data.team.id);
            installTo.set("conferenceName", resp.data.team.name)
            await installTo.save({},{useMasterKey: true});
            //create the sub account
            let account = await masterTwilioClient.api.accounts.create({friendlyName: installTo.id + ": " + resp.data.team.name});
            let newAuthToken = account.authToken;
            let newSID = account.sid;

            let tempClient = Twilio(newSID, newAuthToken);
            let new_key = await tempClient.newKeys.create();
            await addOrReplaceConfig(installTo, "TWILIO_API_KEY", new_key.sid);
            await addOrReplaceConfig(installTo, "TWILIO_API_SECRET", new_key.secret);
            await addOrReplaceConfig(installTo, "TWILIO_ACCOUNT_SID", newSID);
            await addOrReplaceConfig(installTo, "TWILIO_AUTH_TOKEN", newAuthToken);
            await addOrReplaceConfig(installTo, "TWILIO_ROOM_TYPE", "peer-to-peer")
        }

        installTo.set("slackWorkspace", resp.data.team.id);
        installTo.set("pendingWorkspaceName", null);
        await addOrReplaceConfig(installTo, "SLACK_BOT_TOKEN", resp.data.access_token);
        await addOrReplaceConfig(installTo, "SLACK_BOT_USER_ID", resp.data.bot_user_id);
        // await addOrReplaceConfig("SLACK_BOT_ID", resp.data.access_token);


        //Delete any tokens that exist


        await installTo.save({}, {useMasterKey: true});
        // res.send("Installation success. Please email Jonathan Bell at jon@jonbell.net to complete setup.");
        res.redirect("https://www.clowdr.org/beta_success.html");
    })
});

async function getSession(token) {
    let query = new Parse.Query(Parse.Session);
    query.include("user");
    query.include("currentConference");
    query.equalTo("sessionToken", token);
    let session = await query.first({useMasterKey: true});
    if (session) {
        return session;
    }
    return undefined;
}

app.post("/video/new", bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res) => {
  return await createNewRoom(req, res);
});

async function createNewRoom(req, res){
    //Validate parse user can create this room
    let token = req.body.identity;
    // let conf = req.body.conf;
    // let confID = req.body.confid;
    let teamName = req.body.slackTeam;
    let confID = req.body.conference;
    console.log("Create new room: Fetch conference")
    let conf = await getConference(teamName);
    if (!conf) {
        conf = await getConferenceByParseID(confID);
    }
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
        let session = await query.first({useMasterKey: true});
        console.log("Create new room: Got user from session token")
        if (session) {
            let parseUser = session.get("user");
            //Validate has privileges for conference
            const accesToConf = new Parse.Query(InstancePermission);
            accesToConf.equalTo("conference", conf);
            accesToConf.equalTo("action", privilegeRoles['createVideoRoom']);
            console.log('--> ' + JSON.stringify(privilegeRoles['createVideoRoom']));
            //TODO access-check for each option, too, but I don't have time now...
            const hasAccess = await accesToConf.first({sessionToken: token});
            console.log('Permission to create video room? ' + hasAccess);
            if (hasAccess && hasAccess.id) {
                //Try to create the room
                try {
                    console.log("creating room with callback" + conf.config.TWILIO_CALLBACK_URL)
                    console.log("For " + parseUser.id + ": " + parseUser.get("displayname"))
                    console.log(roomName)
                    let maxParticipants = (mode == "peer-to-peer" ? 10 : (mode == "group-small" ? 4 : 10));
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
                    parseRoom.set("isPrivate", visibility=="unlisted");
                    parseRoom.set("persistence", persistence);
                    parseRoom.set("mode", mode);
                    parseRoom.set("capacity", maxParticipants);
                    if(socialSpaceID){
                        let socialSpace  =new SocialSpace();
                        socialSpace.id = socialSpaceID;
                        parseRoom.set("socialSpace", socialSpace);
                    }
                    let modRole = await getOrCreateRole(conf.id,"moderator");

                    let acl = new Parse.ACL();
                    acl.setPublicReadAccess(false);
                    acl.setPublicWriteAccess(false);
                    acl.setRoleReadAccess(modRole, true);
                    if (visibility == "unlisted") {
                        acl.setReadAccess(parseUser.id, true);
                    }
                    else{
                        acl.setRoleReadAccess(await getOrCreateRole(conf.id,"conference"), true);
                    }
                    parseRoom.setACL(acl, {useMasterKey: true});
                    await parseRoom.save({}, {useMasterKey: true});
                    let attributes = {
                        category: "breakoutRoom",
                        roomID: parseRoom.id
                    }

                    let twilioChatRoom = await chat.channels.create({
                        friendlyName: roomName,
                        attributes: JSON.stringify(attributes),
                        type:
                            (visibility == "unlisted" ? "private" : "public")
                    });
                    if(visibility == "unlisted"){
                        //give this user access to the chat
                        let userProfile = await getUserProfile(parseUser.id, conf);
                        console.log("Creating chat room for " + roomName + " starting user " + userProfile.id)
                        await chat.channels(twilioChatRoom.sid).members.create({identity: userProfile.id});
                        //Make sure that all moderators and admins have access to this room, too.
                        let modRole = await getOrCreateRole(conf.id,"moderator");
                        let userQuery = modRole.getUsers().query();
                        let profilesQuery = new Parse.Query(UserProfile);
                        profilesQuery.equalTo("conference", conf);
                        profilesQuery.matchesQuery("user", userQuery);
                        profilesQuery.find({useMasterKey: true}).then((users)=>{
                            for(let user of users){
                                chat.channels(twilioChatRoom.sid).members.create({identity: user.id});
                            }
                        })
                    }
                    parseRoom.set("twilioChatID", twilioChatRoom.sid);
                    await parseRoom.save({},{useMasterKey: true});
                    sidToRoom[twilioRoom.sid] = parseRoom;
                    conf.rooms.push(parseRoom);
                    return res.send({status: "OK"});
                } catch (err) {
                    console.log(err);
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
        console.log(err);
        return res.send({status: "error", message: "Internal server error "});
    }
    return res.send({
        status: "error",
        message: "Could not find enrollment for this user on this conference, " + conf
    });
}

async function removeFromCall(twilio, roomSID, identity) {
    console.log("Kick: " + identity);
    try {
        let participant = await twilio.video.rooms(roomSID).participants(identity).update({status: 'disconnected'})
    } catch (err) {
        console.log(err);
        //might not be in room still.
    }
}
var uidToProfileCache = {};
async function getUserProfile(uid, conf){

    let cacheKey = uid+"-"+conf.id;
    console.log(cacheKey)
    if(!uidToProfileCache[cacheKey])
    {
        let uq = new Parse.Query(UserProfile);
        let fauxUser = new Parse.User();
        fauxUser.id = uid;
        uq.equalTo("user", fauxUser);
        uq.equalTo("conference", conf);
        let res = await uq.first({useMasterKey: true});
        console.log(res);
        uidToProfileCache[cacheKey] = res;
    }
    return uidToProfileCache[cacheKey];
}
async function updateFollow(req,res){
    try {
        let identity = req.body.identity;
        const roomID = req.body.roomID;
        const conference = req.body.slackTeam;
        const users = req.body.users;
        const add = req.body.add;

        let conf = await getConference(conference);
        let userQ = new Parse.Query(Parse.Session);
        userQ.equalTo("sessionToken", identity);
        // let parseSession = await userQ.first({useMasterKey: true});
        // let parseUser = parseSession.get("user");
        let profileQ = new Parse.Query(UserProfile);
        profileQ.equalTo("conference", conf);
        profileQ.matchesKeyInQuery("user","user", userQ);
        let profile = await profileQ.first({useMasterKey: true});
        //Check for roles...
        let roomQ = new Parse.Query("BreakoutRoom");
        let room = await roomQ.get(roomID, {sessionToken: identity});
        if (!room) {
            return res.send({status: 'error', message: "No such room"});
        }
        let watchers = room.get("watchers");
        if(!watchers)
            watchers = [];
        if(add)
            watchers.push(profile);
        else
            watchers = watchers.filter(p=>p.id != profile.id);
        room.set("watchers", watchers);
        await room.save({}, {useMasterKey: true});
        res.send({status: "OK"});
    } catch (err) {
        console.log(err);
        res.send({status: "error", message: "Internal server error"});
    }
}

async function updateACL(req,res){
    try {
        let identity = req.body.identity;
        const roomID = req.body.roomID;
        const conference = req.body.slackTeam;
        const users = req.body.users;
        let conf = await getConference(conference);
        let userQ = new Parse.Query(Parse.Session);
        userQ.equalTo("sessionToken", identity);
        userQ.include(["user.displayname"]);
        let parseSession = await userQ.first({useMasterKey: true});
        let parseUser = parseSession.get("user");
        //Check for roles...
        let roomQ = new Parse.Query("BreakoutRoom");
        roomQ.include("conversation");
        let room = await roomQ.get(roomID, {sessionToken: identity});
        if (!room) {
            return res.send({status: 'error', message: "No such room"});
        }
        let usersWithAccessCurrently = Object.keys(room.getACL().permissionsById).filter(v=>!v.startsWith("role"));

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
                let user = await uq.get(uid,{useMasterKey: true});
                //find the profile for this user, since that's what we want to put into twilio
                let userProfile = await getUserProfile(uid, conf);
                promises.push(removeFromCall(conf.twilio, room.get("twilioID"), userProfile.id));
                promises.push(chat.channels(room.get("twilioChatID")).members(userProfile.id).remove().catch(err=>console.log(err)));
            }
        }
        for (let user of users) {
            if (!usersWithAccessCurrently.includes(user)) {

                if(room.get("conversation"))
                    room.get("conversation").getACL().setReadAccess(user, true);
                room.getACL().setReadAccess(user, true);
                let userProfile = await getUserProfile(user, conf);
                promises.push(chat.channels(room.get("twilioChatID")).members.create({identity: userProfile.id}));
                let fauxUser = new Parse.User();
                fauxUser.id = user;
                usersToRefresh.push(fauxUser);
            }
        }
        if (room.get("conversation")) {
            await room.get("conversation").save({}, {useMasterKey: true});
        }
        if (users.length == 0) {
            await room.destroy({useMasterKey: true});
        } else {
            await room.save({}, {useMasterKey: true});
        }
        await Promise.all(promises);

        promises = [];
        for(let user of usersToRefresh){
            promises.push(pushToUserStream(user, conf, "privateBreakoutRooms"));
        }
        await Promise.all(promises);
        res.send({status: "OK"});
    } catch (err) {
        console.log(err);
        res.send({status: "error", message: "Internal server error"});
    }
}
async function getModeratorChannel(conf){
    return conf.moderatorChannel;
}
async function sendModeratorMessage(req,res){
    let identity = req.body.identity;
    const roomID = req.body.roomID;
    const conference = req.body.slackTeam;
    const participants = req.body.participants;
    let conf = await getConference(conference);
    let userQ = new Parse.Query(Parse.Session);
    userQ.equalTo("sessionToken", identity);
    let parseSession = await userQ.first({useMasterKey: true});
    let parseUser = parseSession.get("user");
    let profileQ = new Parse.Query(UserProfile);
    profileQ.equalTo("user", parseUser);
    profileQ.equalTo("conference", conf);
    let profile = await profileQ.first({useMasterKey: true});
    //Check for roles...
    let roomQ = new Parse.Query("BreakoutRoom");
    let room = await roomQ.get(roomID, {sessionToken: identity});
    if (!room) {
        return res.send({status: 'error', message: "No such room"});
    }
    let unfilledUsers = [];
    for(let id of participants){
        unfilledUsers.push(UserProfile.createWithoutData(id));
    }
    let users = await Parse.Object.fetchAll(unfilledUsers, {useMasterKey: true});
    let usersString = "";
    for(let user of users){
        usersString += user.get("displayName")+", ";
    }
    if(usersString.length > 0){
        usersString = usersString.substring(0,usersString.length - 2);
    }
    //Compose and send a message on slack.
    let slack = conf.config.slackClient;
    let channel = await getModeratorChannel(conf);
    await conf.config.slackClient.chat.postMessage({channel: channel,
        text: "Moderation request from web",
        blocks:[
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "A moderation request was received from "+profile.get("displayName")+" " +
                        " while in the web chat room titled: '"+room.get("title")+"', which contained at the time " +
                        "the following users: " + usersString + ". Message follows:"
                }
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": ">"+req.body.message.replace("\n","\n>")
                }
            }
        ]
    })



    res.send({status: "OK"});
}
app.post("/moderator/fromVideo", bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res) => {
    try {
        await sendModeratorMessage(req, res);
    }catch(err){
        res.status(500);
        res.send({status: "error", message: "An internal server error occurred."})
        console.log(err);
    }
})
app.post("/video/acl", bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res) => {
    await updateACL(req, res);
})
app.post("/video/follow", bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res) => {
    await updateFollow(req, res);
})
app.post("/video/token", bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res) => {
    try {
        await mintTokenForFrontend(req, res);
    } catch (err) {
        console.log("Not found when minting")
        console.log(err);
        res.status(500);
        res.send({status: "error", message: "Internal server error"});
    }

});
async function createTwilioRoomForParseRoom(parseRoom, conf){
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
    let conf = await getConferenceByParseID(conference);
    if(!conf.config.TWILIO_ACCOUNT_SID){
        res.status(403);
        console.log("Received invalid conference request: ");
        console.log(req.body);
        res.send({status: "error", message: "Conference not configured."})
        return;
    }
    let userQ = new Parse.Query(Parse.Session);
    userQ.equalTo("sessionToken", identity);
    // userQ.include(["user.displayname"]);
    // console.log(identity)
    let parseSession = await userQ.first({useMasterKey: true});
    let parseUser = parseSession.get("user");
    let userProfileQ = new Parse.Query(UserProfile);
    userProfileQ.equalTo("user", parseUser);
    userProfileQ.equalTo("conference", conf);
    let userProfile = await userProfileQ.first({useMasterKey: true});
    identity = userProfile.id;

    // console.log("Get token for video for " + identity + " " + room)
    if (!room) {
        res.status(404);
        res.error();
    }
    let query = new Parse.Query("BreakoutRoom");
    let roomData = await query.get(room, {sessionToken: req.body.identity});
    if (!roomData.get("twilioID")) {
        if (roomData.get("persistence") == "persistent") {
            //Create a new twilio room
            try {
                let twilioRoom = await createTwilioRoomForParseRoom(roomData, conf);
                roomData.set("twilioID", twilioRoom.sid);
                await roomData.save({}, {useMasterKey: true});
                sidToRoom[twilioRoom.sid] = roomData;
            } catch (err) {
                //If an error ocurred making the twilio room, someone else must have updated it.
                console.log(err);
                let twilioRoom = await conf.twilio.video.rooms(roomData.get("title")).fetch();
                roomData.set("twilioID", twilioRoom.sid)
                await roomData.save({}, {useMasterKey: true});
                sidToRoom[twilioRoom.sid] = roomData;
            }
        } else {
            res.status(404);
            return res.send({message: "This room has been deleted"});
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

app.post("/slack/login", bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res) => {
    //Decode and verify token
    try {
        let payload = jwt.verify(req.body.token, process.env.CLOWDR_JWT_KEY);

        // console.log(payload);
        let uid = payload.uid;
        let team = payload.team;
        let secret = payload.secret;
        let roomName = payload.roomName;
        let userQ = new Parse.Query(Parse.User);
        let user = await userQ.get(uid, {useMasterKey: true});
        if (user.get('loginKey') == secret) {
            let fakeSession = Parse.Object.extend("_Session");
            let newSession = new fakeSession();
            // console.log(user)
            newSession.set("user", user);
            newSession.set("createdWith", {action: "login", "authProvider": "clowdr"});
            newSession.set("restricted", false);
            newSession.set("expiresAt", moment().add("1", "year").toDate());
            newSession.set("sessionToken", "r:" + await generateRandomString(24))
            newSession = await newSession.save({}, {useMasterKey: true});
            // console.log("Created new token: " + newSession.getSessionToken() + " for " + uid)
            return res.send({
                token: newSession.getSessionToken(),
                team: payload.team, roomName: payload.roomName
            });
        }
        res.send({status: "error"});
    } catch (err) {
        //TODO send login info
        console.log(err);
        res.status(403);
        res.send({status: err});
    }
})

app.post('/chat/token',bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res, next) => {
    const identity = req.body.identity;
    try {
        let sessionObj = await getSession(identity);
        if(!sessionObj){
            res.status(403);
            res.send({status: "Invalid token"})
            return;
        }
        console.log('[/chat/token]: conference: ' + JSON.stringify(req.body.conference));
        let conf = await getConferenceByParseID(req.body.conference);

        try {
            const accessToken = new AccessToken(conf.config.TWILIO_ACCOUNT_SID, conf.config.TWILIO_API_KEY, conf.config.TWILIO_API_SECRET,
                {ttl: 3600 * 24});
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
            res.send(JSON.stringify({status: "Error", message: err}));
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
    return roles.find(r => allowedRoles.find(allowed => r.get("name") == allowed));
}
async function sessionTokenIsFromModerator(sessionToken, confID){
    let session = await getSession(sessionToken);
    let user = session.get("user");
    return await userInRoles(user, [confID+"-moderator",confID+"-admin",confID+"-manager"]);
}
app.post('/chat/deleteMessage',bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res, next) => {
    const identity = req.body.identity;
    const messageSID = req.body.message;
    const channelSID = req.body.room;
    try {
        const hasAccess = await sessionTokenIsFromModerator(identity, req.body.conference);
        let conf = await getConferenceByParseID(req.body.conference);
        if(!hasAccess){
            res.status(403);
            res.send();
            return;
        }
        let chat = await conf.twilio.chat.services(conf.config.TWILIO_CHAT_SERVICE_SID).channels(channelSID).messages(messageSID).remove();
        res.send({status: "OK"});
    } catch (err) {
        next(err);
    }
    // newNode[uid] = true;
    // let membersRef = roomRef.child("members").child(uid).set(true).then(() => {
    // });
});

app.post('/video/deleteRoom',bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res, next) => {
    const identity = req.body.identity;
    const roomID = req.body.room;
    let conf = await getConference(req.body.conference);
    try {
        // const accesToConf = new Parse.Query(InstancePermission);
        // accesToConf.equalTo("conference", conf);
        // accesToConf.equalTo("action", privilegeRoles['moderator']);
        // const hasAccess = await accesToConf.first({sessionToken: identity});
        const hasAccess = await sessionTokenIsFromModerator(identity, conf.id);
        if(!hasAccess){
            res.status(403);
            res.send();
            return;
        }
        //First, remove all users.
        let roomQ = new Parse.Query(BreakoutRoom);
        let room = await roomQ.get(roomID, {useMasterKey: true});
        if(!room){
            console.log("Unable to find room:" + roomID)
        }
        let promises = [];
        if(room.get("members")){
            for(let member of room.get("members")){
                console.log("Kick: " + member.id);
                promises.push(removeFromCall(conf.twilio,room.get("twilioID"), member.id));
            }
        }
        await Promise.all(promises);
        await room.destroy({useMasterKey: true});
        res.send({status: "OK"});
    } catch (err) {
        next(err);
    }
    // newNode[uid] = true;
    // let membersRef = roomRef.child("members").child(uid).set(true).then(() => {
    // });
});


app.post('/users/ban',bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res, next) => {
    const identity = req.body.identity;
    const profileToBan = req.body.profileID;
    const isBan = req.body.isBan;
    let conf = await getConference(req.body.conference);
    try {
        // const accesToConf = new Parse.Query(InstancePermission);
        // accesToConf.equalTo("conference", conf);
        // accesToConf.equalTo("action", privilegeRoles['moderator']);
        const hasAccess = await sessionTokenIsFromModerator(identity, conf.id);
        if(!hasAccess){
            res.status(403);
            res.send();
            return;
        }
        let profileQ = new Parse.Query(UserProfile);
        profileQ.include("user");
        let profile = await profileQ.get(profileToBan, {useMasterKey: true});
        if(isBan){
            profile.set("isBanned",true);
            let bannedACL = new Parse.ACL();
            bannedACL.setWriteAccess(profile.get("user"), false);
            bannedACL.setRoleReadAccess(conf.id+"-conference", true);
            profile.setACL(bannedACL);
            await profile.save({},{useMasterKey: true});

            //Deny user read access to their own record
            let user = profile.get("user");
            let bannedUserACL = new Parse.ACL();
            user.setACL(bannedUserACL);
            await user.save({},{useMasterKey: true});
        }else{
            profile.set("isBanned",false);
            let notBannedACL = new Parse.ACL();
            notBannedACL.setWriteAccess(profile.get("user"), true);
            notBannedACL.setRoleReadAccess(conf.id+"-conference", true);

            profile.setACL(notBannedACL);
            await profile.save({}, {useMasterKey: true});
            let user = profile.get("user");

            let userACL = new Parse.ACL();
            userACL.setWriteAccess(user, true);
            userACL.setReadAccess(user, true);
            user.setACL(userACL);
            await user.save({},{useMasterKey: true});

        }
        await pushToUserStream(profile.get("user"), conf, "profile");
        res.send({status: "OK"});
    } catch (err) {
        res.status(500);
        console.log(err);
        res.send({status: "error", message: "Internal server error, please check logs"})
    }
    // newNode[uid] = true;
    // let membersRef = roomRef.child("members").child(uid).set(true).then(() => {
    // });
});




//for testing...
// app.get("/video/token", async (req, res) => {
//     let payload = jwt.verify(req.query.token, process.env.CLOWDR_JWT_KEY);
//     console.log("Vidoe token from slack")
//     let conf = await getConference(payload.team);
//     try {
//         let token = videoToken(payload.identity, payload.roomSID, conf.config).toJwt();
//         //respond with the actual token
//         res.send(token);
//     } catch (err) {
//         console.log(err);
//         res.status(500);
//         res.send();
//     }
// });

// var parseLive = new Parse.LiveQueryClient({
//     applicationId: process.env.REACT_APP_PARSE_APP_ID,
//     serverURL: process.env.REACT_APP_PARSE_DOMAIN,
//     javascriptKey: process.env.REACT_APP_PARSE_JS_KEY,
// });
// parseLive.open();
// parseLive.on("error", (err) => {
//     console.error("Subscription error")
//     console.log(err);
// });
//At boot, we should still clear out our cache locally
async function runBackend() {
    let promises = [];

    let query = new Parse.Query("BreakoutRoom");
    query.limit(100);
    let rooms = await query.find({useMasterKey: true});
    for(let room of rooms){
        parseRoomCache[room.id] = room;
        sidToRoom[room.get("twilioID")] = room;
    }

    await getPrivileges();

    if (!process.env.SKIP_INIT) {
        let query = new Parse.Query(ClowdrInstance);
        query.find({useMasterKey: true}).then((instances) => {
            instances.forEach(
                async (inst) => {
                    try {
                        if (inst.get("slackWorkspace")) //&& inst.id =='pvckfSmmTp')
                            promises.push(getConference(inst.get("slackWorkspace")).then((conf) => {
                                console.log("Finished " + conf.get("conferenceName"))
                            }).catch(err => {
                                console.log("Unable to load data for  " + inst.get("conferenceName"))
                                console.log(err);
                            }));
                    } catch (err) {
                        console.log(err);
                    }
                }
            )
        }).catch((err) => {
            console.log(err);
        });
    }
    Promise.all(promises).then(() => {
        app.listen(process.env.PORT || 3001, () =>
            console.log('Express server is running on localhost:3001')
        );
    });
}

runBackend();
