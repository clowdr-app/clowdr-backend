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


const slackEvents = createEventAdapter(process.env.SLACK_SIGNING_SECRET);
const slackInteractions = createMessageAdapter(process.env.SLACK_SIGNING_SECRET);

const {videoToken, ChatGrant, AccessToken} = require('./tokens');
const axios = require('axios');
const qs = require('qs');

var cors = require('cors')

const Twilio = require("twilio");


Parse.initialize(process.env.REACT_APP_PARSE_APP_ID, process.env.REACT_APP_PARSE_JS_KEY, process.env.PARSE_MASTER_KEY);
Parse.serverURL = process.env.REACT_APP_PARSE_DATABASE_URL;


const app = express();
app.use(cors())
app.use('/slack/events', slackEvents.expressMiddleware());

app.use('/slack/interaction', slackInteractions.expressMiddleware());
app.post('/slack/commands', bodyParser.urlencoded({extended: false}), slackSlashCommand);
const sidToRoom = {};
const confCache = {};
const userToAuthData = {};
const userToWorkspaces = {};

let SlackHomeBlocks = Parse.Object.extend("SlackHomeBlocks");
let ClowdrInstance = Parse.Object.extend("ClowdrInstance");
let InstanceConfig = Parse.Object.extend("InstanceConfiguration");
let Channel = Parse.Object.extend("Channel");
let BreakoutRoom = Parse.Object.extend("BreakoutRoom");


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
let User = Parse.Object.extend("User");

async function populateActiveChannels(conf) {
    //TODO map to a single conference?
    let roomQuery = new Parse.Query(BreakoutRoom);
    roomQuery.equalTo("conference", conf)
    roomQuery.include(["members"]);
    let rooms = await roomQuery.find();
    return rooms;
}

async function getConference(teamID, teamDomain) {
    // try {
    if (confCache[teamID])
        return confCache[teamID];

    let q = new Parse.Query(ClowdrInstance);
    let r = undefined;
    try {
        q.equalTo("slackWorkspace", teamID);
        r = await q.first();
    }
    catch(err){
        console.log(err);
    }
    // } catch (err) {
    if (!r) {
        console.log("Unable to find workspace in ClowdrDB: " + teamID + ", " + teamDomain);
    }
    r.rooms = await populateActiveChannels(r);
    r.config = await getConfig(r);
    r.twilio = Twilio(r.config.TWILIO_ACCOUNT_SID, r.config.TWILIO_AUTH_TOKEN);

    //This is the first time we hit this conference on this run, so we should also grab the state of the world from twilio


    let roomsInTwilio = await r.twilio.video.rooms.list();
    for (let room of roomsInTwilio) {
        if (room.status == 'in-progress') {
            if (r.rooms.filter((i) => i.get("twilioID") == room.sid).length == 0) {
                //make a new room with room.uniqueName
                let parseRoom = new BreakoutRoom();
                parseRoom.set("conference", r);
                parseRoom.set("twilioID", room.sid);
                parseRoom.set("title", room.uniqueName);
                parseRoom = await parseRoom.save();
                r.rooms.push(parseRoom);
            }
        } else if (room.status == 'completed') {
            //make sure we dont have it

        }
    }

    for (let parseRoom of r.rooms) {
        let found = roomsInTwilio.filter((i) => i.sid == parseRoom.get("twilioID"));
        if (found.length == 1 && found[0].status == 'in-progress') {
            sidToRoom[parseRoom.get("twilioID")] = parseRoom;
            //sync members
            let participants = await r.twilio.video.rooms(parseRoom.get("twilioID")).participants.list();
            for(let participant of participants){
                let ident = participant.identity;
                let uid = ident.substring(0, ident.indexOf(":"));
                let userFindQ = new Parse.Query(User);
                try {
                    let user = await userFindQ.get(uid);
                    if (!parseRoom.get("members")) {
                        parseRoom.set("members", [user]);
                    } else {
                        if (parseRoom.get("members").filter((u) => u.id == uid).length == 0)
                            parseRoom.get("members").push(user);
                    }
                }catch(err){
                    console.log("Missing user record: " + uid)
                    console.log(err);
                }
            }
            let membersToRemove = [];
            if (parseRoom.get("members")) {
                for (let member of parseRoom.get("members")) {
                    let found = participants.filter((p) => {
                        let uid = p.identity.substring(0, p.identity.indexOf(':'));
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
            await parseRoom.save();
        } else {
            //room no logner exists
            parseRoom.destroy();
            r.rooms = r.rooms.filter((r) => r.id != parseRoom.id);
        }
    }

    confCache[teamID] = r;
    return r;
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
        config.FRONTEND_URL = "https://staging.clowdr.org"
    }
    if (!config.TWILIO_CALLBACK_URL) {
        config.TWILIO_CALLBACK_URL = "https://clowdr.herokuapp.com/twilio/event"
        // config.TWILIO_CALLBACK_URL = "https://clowdr-dev.ngrok.io/twilio/event"
    }
    if(!config.TWILIO_ROOM_TYPE){
        config.TWILIO_ROOM_TYPE = "group";
    }
    if(!config.AUTO_CREATE_USER){
        config.AUTO_CREATE_USER = true;
    }
    // config.TWILIO_CALLBACK_URL = "https://clowdr-dev.ngrok.io/twilio/event";
    config.slackClient = new WebClient(config.SLACK_BOT_TOKEN);
    // console.log(JSON.stringify(config,null,2))
    return config;
}
function pushActiveCallsFromConfToBlocks(conf, blocks, parseUser, teamID){
    if(conf.rooms.length == 0){
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
            text: conf.get("shortName") + " participants are hanging out in the following video chats. " +
                "Join one of these, or create a new room by sending a new message `/video [name of room to join or create]`"
        }
    })
    for (let room of conf.rooms) {
        let membersString = "";
        if (room.get("members")) {
            for (let member of room.get("members")) {
                membersString += "<@" + member.get("slackID") + ">,"
            }
        }
        if (membersString.length > 0) {
            membersString = membersString.substring(0, membersString.length - 1);
        } else {
            membersString = "(Empty)"
        }
        let joinAccy;

        const link = buildLink(room.id, room.get("title"), parseUser, conf, teamID);
        joinAccy = {
            type: "button",
            action_id: "join_video",
            value: room.id,
            url: link,
            text: {
                type: "plain_text",
                text: "Join Video"
            }
        }
        let block = {
            type: "section",
            text: {
                type: "mrkdwn",
                text: room.get("title") + ": " + membersString,
            },
            accessory: joinAccy
        }
        blocks.push(block);
    }
    // console.log(JSON.stringify(blocks, null, 2));
}

async function ensureUserHasTeamRole(user, conf) {
    let confID = conf.id;
    if (userToWorkspaces[user.id] && userToWorkspaces[user.id][conf.id]) {
        return;
    }
    //Check in DB
    const roleQuery = new Parse.Query(Parse.Role);
    roleQuery.equalTo("users", user);
    roleQuery.equalTo("name", "Conf" + conf.get("conferenceName"));
    const roles = await roleQuery.find({useMasterKey: true});
    if (!roles|| roles.length == 0) {
        let roleQ = new Parse.Query(Parse.Role);
        roleQ.equalTo("name","Conf"+conf.get("conferenceName"));
        let role = await roleQ.first({useMasterKey: true});
        if(!role){
            role = new Parse.Role();
            role.set("name","Conf"+conf.get("conferenceName"));
            let acl = new Parse.ACL();
            acl.setPublicWriteAccess(false);
            acl.setPublicReadAccess(true);
            role.setACL(acl);
            // role.set("acl",acl);
            // role.set("users",[]);
        }
        role.getUsers().add(user);
        await role.save({},{useMasterKey: true});
    }
    if(!userToWorkspaces[user.id]){
        userToWorkspaces[user.id] = {};
    }
    userToWorkspaces[user.id][conf.id] = 1;
}

async function getOrCreateParseUser(slackUID, conf, slackClient) {
    //First try retrieving by slack ID
    let q = new Parse.Query(Parse.User);
    q.equalTo("slackID", slackUID);
    let u = await q.first({useMasterKey: true});
    if (u) {
        await ensureUserHasTeamRole(u, conf);
        return u;
    }
    //Now try to retrieve by email

    try {
        let user_info = await slackClient.users.info({user: slackUID});
        q = new Parse.Query(Parse.User);
        q.equalTo("email", user_info.user.profile.email);
        u = await q.first();
        if (u) {
            u.set("slackID", slackUID);
            await u.save({}, {useMasterKey: true});
            await ensureUserHasTeamRole(u, conf);
            return u;
        }
        if(!conf.config.AUTO_CREATE_USER){
            return null; //TODO send an error back to the user, include the email address and conference name
        }

        //Fallback. Create a new user in parse to represent this person.
        let user = new Parse.User();
        user.set("username", user_info.user.profile.email);
        user.set("displayname", user_info.user.profile.real_name);
        user.set("password", user_info.user.profile.email + Math.random());
        user.set("email", user_info.user.profile.email);
        user = await user.signUp();
        await ensureUserHasTeamRole(user, conf);
        return user;
    } catch (err) {
        console.log(err);
        return null;
    }
}

async function generateHome(conf, parseUser, teamID) {
    let q = new Parse.Query(SlackHomeBlocks);
    q.equalTo("conference", conf);
    q.addAscending("sortKey");
    let dbBlocks = await q.find();
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

    pushActiveCallsFromConfToBlocks(conf, blocks, parseUser, teamID);

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

async function buildLink(roomID,roomName, parseUser, conf, teamID) {

    let link = conf.config.FRONTEND_URL;
    if (link.endsWith('/'))
        link = link.substring(0, link.length - 1);
    if (!userToAuthData[parseUser.id]) {
        let secret = await generateRandomString(48);
        userToAuthData[parseUser.id] = secret;
        parseUser.set("loginKey", secret);
        parseUser.set("loginExpires", moment().add("8","hours").toDate());
        await parseUser.save({}, {useMasterKey: true});
    }
    let token = jwt.sign({
        uid: parseUser.id,
        team: teamID,
        secret: userToAuthData[parseUser.id],
        roomName: roomName,
    }, process.env.CLOWDR_JWT_KEY, {expiresIn: '8h'});

    // console.log("WOrking to make a link for " + parseUser.get("displayname") +", " + parseUser.id)

    link = link + '/fromSlack/' + encodeURI(teamID) + '/' + encodeURI(roomName) + '/' +
        encodeURI(token);
    return link;
}

function respondWithError(response_url, error) {
    const message = {
        "text": "Sorry, I was unable to process your request. " + error,
        "response_type": "ephemeral",
    };

    return axios.post(response_url, message
    ).catch(console.error);
}
function sendMessageWithLinkToUser(response_url, messageText, linkText, link){
    const message = {
        "text": messageText+". <"+link+"|"+linkText+">",
        "response_type": "ephemeral",
        // Block Kit Builder - http://j.mp/bolt-starter-msg-json
        // "blocks": [
        //     {
        //         "type": "section",
        //         "text": {
        //             "type": "mrkdwn",
        //             "text": messageText+". <"+link+"|"+linkText+">",
        //         }
        //     },
            // {
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
            // }
        // ]
    };

    return axios.post(response_url, message);
}
async function sendJoinLinkToUser(body, roomName, peerToPeer) {
    if(!roomName)
    {
        respondWithError(body.response_url, "You need to specify a room name");
        return;
    }
    if(roomName.startsWith("!")){
        respondWithError(body.response_url, "Room names can not begin with special characters")
    }
    let conf = await getConference(body.team_id, body.team_domain)
    let twilio = conf.twilio;
    let slackClient = conf.config.slackClient;
    const uid = body.user_id;
    const parseUser = await getOrCreateParseUser(body.user_id, conf, slackClient);

    let user_info = await slackClient.users.info({user: uid});
    let real_name = user_info.user.real_name;


    // Find the corresponding twilio channel
    var twilioRoom;
    try {
        twilioRoom = await twilio.video.rooms.create({
            // type: "peer-to-peer", //TESTING
            type: (peerToPeer ? "peer-to-peer" : conf.config.TWILIO_ROOM_TYPE),
            uniqueName: roomName,
            statusCallback: conf.config.TWILIO_CALLBACK_URL
        });
        //Create a new room in the DB
        let parseRoom = new BreakoutRoom();
        parseRoom.set("title", roomName);
        parseRoom.set("conference", conf);
        parseRoom.set("twilioID", twilioRoom.sid);
        await parseRoom.save();
        sidToRoom[twilioRoom.sid] = parseRoom;
        conf.rooms.push(parseRoom);

    } catch (err) {
        twilioRoom = await twilio.video.rooms(roomName).fetch();
    }

    let roomID = sidToRoom[twilioRoom.sid].id;
    const link = await buildLink(roomID, roomName, parseUser, conf, body.team_id);
    await sendMessageWithLinkToUser(body.response_url, "Join the live video call '" + twilioRoom.uniqueName + "' here! :tv:", "Join Call", link);

}

slackInteractions.action({action_id: "join_video"}, async (payload, respond) => {

    respond({
    });

    return {
    }
});

slackEvents.on("app_home_opened", async (payload) => {
    if (!payload.view)
        return;
    let team_id = payload.view.team_id;
    let conf = await getConference(team_id)
    // console.log(conf);

    const parseUser = await getOrCreateParseUser(payload.user, conf, conf.slackClient);
    const args = {
        token: conf.config.SLACK_BOT_TOKEN,
        user_id: payload.user,
        view: await generateHome(conf, parseUser, payload.view.team_id)
    };

    const result = await axios.post('https://slack.com/api/views.publish', JSON.stringify(args), {
        headers: {
            "Authorization": "Bearer " + conf.config.SLACK_BOT_TOKEN,
            'Content-Type': 'application/json'
        }
    });
});

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
    let conf = await getConference(req.body.team_id, req.body.team_domain)
    //
    // if(req.body.command == "/login"){
    //     res.send();
    //     console.log(req.body);
    //     await sendLoginLinkToUser(conf, req.body);
    // }
    if (req.body.command === '/video_t' || req.body.command === '/video' || req.body.command === '/videoP2P') {
        res.send();
        //Are we in a private channel?

        // if(req.body.channel_name == "privategroup"){
        //     //We should send the message to all of the participants
        //     console.log(req.body.channel_id)
        //     await conf.config.slackClient.conversations.join({channel:req.body.channel_id});
        //     console.log("OK...")
        //     let members = await conf.config.slackClient.conversations.info({
        //         token: conf.config.SLACK_BOT_TOKEN,
        //         as_user: false,
        //         channel: req.body.channel_id
        //     });
        //     console.log(members);
        //     return;
        // }
        if (req.body.text) {
            await sendJoinLinkToUser(req.body, req.body.text, (req.body.command === "/videoP2P"));
        }
        else {
            const parseUser = await getOrCreateParseUser(req.body.user_id, conf, conf.config.slackClient);
            let blocks = [];

            pushActiveCallsFromConfToBlocks(conf, blocks, parseUser, req.body.team_id);
            const message = {
                "text": "Live video information",
                "response_type": "ephemeral",
                // Block Kit Builder - http://j.mp/bolt-starter-msg-json
                "blocks": blocks
            };



            await axios.post(req.body.response_url, message
            ).catch(console.error);
        }
    } else {
        next();
    }
}


app.post("/twilio/event", bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res) => {
    let roomSID = req.body.RoomSid;
    let query = new Parse.Query(Room);
    try {
        let room = sidToRoom[roomSID];
        if (req.body.StatusCallbackEvent == 'participant-connected') {
            let uid = req.body.ParticipantIdentity.substring(0, req.body.ParticipantIdentity.indexOf(":"));
            let userFindQ = new Parse.Query(User);
            let user = await userFindQ.get(uid);
            if (!room.get("members")) {
                room.set("members", [user]);
            } else {
                if (room.get("members").filter((u) => u.id == uid).length == 0)
                    room.get("members").push(user);
            }
            await room.save();


            // let newUser = await roomsRef.child(req.body.RoomName).child("members").child(uid).set(true);
            // console.log("Added " + req.body.ParticipantIdentity + " to " + roomDBID + " count is now " + membersCache[roomDBID]);
            // ;
            // membersCache[req.body.RoomName]++;
        } else if (req.body.StatusCallbackEvent == 'participant-disconnected') {
            let uid = req.body.ParticipantIdentity.substring(0, req.body.ParticipantIdentity.indexOf(":"));
            let userFindQ = new Parse.Query(User);
            if (!room.get("members")) {
                room.set("members", []);
            } else {
                room.set("members", room.get("members").filter((u) => u.id != uid));
            }
            await room.save();
            // } else if(req.body.StatusCallbackEvent == '')
        } else if (req.body.StatusCallbackEvent == 'room-ended') {
            if (room) {
                await room.destroy();
            }
        } else {
        }
    } catch
        (err) {
        console.log(err);
        // next(err);

    }
    res.send();
})

async function addOrReplaceConfig(installTo, key, value) {
    let existingTokenQ = new Parse.Query(ClowdrInstance);
    existingTokenQ.equalTo("key", key);
    existingTokenQ.equalTo("instance", installTo);
    let tokenConfig = await existingTokenQ.first();
    if (!tokenConfig) {
        //Add the token
        tokenConfig = new InstanceConfig();
        tokenConfig.set("key", key);
        tokenConfig.set("instance", installTo);
    }
    tokenConfig.set("value", value);
    return tokenConfig.save();
}

app.get("/slack/auth", async (req, res) => {

    axios.post("https://slack.com/api/oauth.v2.access", qs.stringify({
        client_id: process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code: req.query.code
    })).then(async (resp) => {
        // console.log(resp.data);
        // console.log(req.query.code);
        if (!resp.data.ok) {
            res.send(403, resp.data);
        }
        let q = new Parse.Query(ClowdrInstance);
        q.equalTo("pendingWorkspaceName", resp.data.team.name);
        let q2 = new Parse.Query(ClowdrInstance);
        q2.equalTo("slackWorkspace", resp.data.team.id);
        let mainQ = Parse.Query.or(q, q2);
        let installTo = await mainQ.first();

        installTo.set("slackWorkspace", resp.data.team.id);
        installTo.set("pendingWorkspaceName", null);
        await addOrReplaceConfig(installTo, "SLACK_BOT_TOKEN", resp.data.access_token);
        await addOrReplaceConfig(installTo, "SLACK_BOT_USER_ID", resp.data.bot_user_id);
        // await addOrReplaceConfig("SLACK_BOT_ID", resp.data.access_token);


        //Delete any tokens that exist


        await installTo.save();
        res.send("OK");
    })
});
async function checkToken(token) {
    console.log(token);


    let query = new Parse.Query(Parse.Session);
    query.include("user");
    query.equalTo("sessionToken", token);
    let session = await query.first();
    if (session) {
        let name = session.get("user").get("displayname");
        let id = session.get("user").id;
        return id + ":" + name;
    }
    return undefined;
}
app.post("/video/new", bodyParser.json(), bodyParser.urlencoded({extended: false}), async(req,res)=>{
    //Validate parse user can create this room
    let token = req.body.identity;
    // let conf = req.body.conf;
    // let confID = req.body.confid;
    let teamName = req.body.slackTeam;
    let conf = await getConference(teamName);
    let roomName = req.body.room;
    let twilio = conf.twilio;

    let query = new Parse.Query(Parse.Session);
    // console.log(token);
    query.include("user");
    query.equalTo("sessionToken", token);
    let session = await query.first({useMasterKey: true});
    if (session) {
        //Validate has privileges for conference
        const roleQuery = new Parse.Query(Parse.Role);
        roleQuery.equalTo("users",session.get("user"));
        roleQuery.equalTo("name", "Conf" + conf.get("conferenceName"));
        const roles = await roleQuery.find();
        if (roles) {
            //Try to create the room
            try {
                let twilioRoom = await twilio.video.rooms.create({
                    // type: "peer-to-peer", //TESTING
                    type: conf.config.TWILIO_ROOM_TYPE,
                    uniqueName: roomName,
                    statusCallback: conf.config.TWILIO_CALLBACK_URL
                });
                //Create a new room in the DB
                let parseRoom = new BreakoutRoom();
                parseRoom.set("title", roomName);
                parseRoom.set("conference", conf);
                parseRoom.set("twilioID", twilioRoom.sid);
                await parseRoom.save();
                sidToRoom[twilioRoom.sid] = parseRoom;
                conf.rooms.push(parseRoom);
                return res.send({status: "OK"});
            } catch (err) {
                return res.send({
                    status: "error",
                    message: "There is already a video room with this name. Please either join the existing room or pick a new name."
                });
            }
        } else {
            return res.send({
                status: "error",
                message: "Could not find enrollment for this user on this conference, " + conf
            });
        }

    }
    return res.send({
        status: "error",
        message: "Could not find enrollment for this user on this conference, " + conf
    });
});
app.post("/video/token",bodyParser.json(), bodyParser.urlencoded({extended: false}), async(req,res)=>{
    let identity = req.body.identity;
    const room = req.body.room;
    const conference = req.body.conf;
    let conf = await getConference(conference);
    let userQ = new Parse.Query(Parse.Session);
    userQ.equalTo("sessionToken", identity);
    userQ.include(["user.displayname"]);
    // console.log(identity)
    let parseSession = await userQ.first({useMasterKey: true});
    let parseUser = parseSession.get("user");
    identity = parseUser.id+":"+parseUser.get("displayname");
    // console.log(identity);
    // console.log(parseSession);
    // console.log(parseSession.get("user"))


    // console.log("Get token for video for " + identity + " " + room)
    if (!room) {
        res.error();
    }
    let query = new Parse.Query("BreakoutRoom");
    let roomData = await query.get(room);
    let newNode = {};
    if (!roomData) {
        res.error();
    }
    const token = videoToken(identity, roomData.get('twilioID'), conf.config);
    // console.log("Sent response" + token);
    sendTokenResponse(token, roomData.get('title'), res);

    // newNode[uid] = true;
    // let membersRef = roomRef.child("members").child(uid).set(true).then(() => {
    // });
});

app.post("/slack/login", bodyParser.json(), bodyParser.urlencoded({extended: false}), async(req,res)=>{
    //Decode and verify token
    try {
        let payload = jwt.verify(req.body.token, process.env.CLOWDR_JWT_KEY);

        // console.log(payload);
        let uid = payload.uid;
        let team  = payload.team;
        let secret = payload.secret;
        let roomName = payload.roomName;
        let userQ = new Parse.Query(Parse.User);
        let user = await userQ.get(uid, {useMasterKey: true});
        if (user.get('loginKey') == secret) {
            let fakeSession = Parse.Object.extend("_Session");
            let newSession = new fakeSession();
            newSession.set("user", user);
            newSession.set("createdWith", {action: "login", "authProvider": "clowdr"});
            newSession.set("restricted", false);
            newSession.set("expiresAt", moment().add("8", "hours").toDate());
            newSession.set("sessionToken", "r:" + await generateRandomString(24))
            newSession = await newSession.save({}, {useMasterKey: true});
            return res.send({token: newSession.getSessionToken(),
            team: payload.team, roomName: payload.roomName});
        }
        res.send({status: "error"});
    }catch(err){
        //TODO send login info
        console.log(err);
        res.send(403, {status: err});
    }
})


app.get("/video/token", async(req,res)=>{
    let payload = jwt.verify(req.query.token, process.env.CLOWDR_JWT_KEY);
    let conf = await getConference(payload.team);
    let token = videoToken(payload.identity, payload.roomSID, conf.config).toJwt();
    //respond with the actual token
    res.send(token);
});
//At boot, we should still clear out our cache locally
let query = new Parse.Query(ClowdrInstance);
query.find({useMasterKey: true}).then((instances) => {
    instances.forEach(
        async (inst)=>{
            try {
                if (inst.get("slackWorkspace"))
                    await getConference(inst.get("slackWorkspace"));
            }catch(err){
                console.log(err);
            }
        }
    )
}).catch((err) =>{
    console.log(err);
});

app.listen(process.env.PORT || 3001, () =>
    console.log('Express server is running on localhost:3001')
);
