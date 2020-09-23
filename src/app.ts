"use strict";

import assert from "assert";
import Parse from "parse/node";
import Express, { Request, Response, NextFunction } from 'express';
import CORS from 'cors';
import BodyParser from "body-parser";
// import Twilio from "twilio";
// import JWT from 'jsonwebtoken';

import { getSession, getConference, getUserProfile } from "./ParseHelpers";

// import moment from "moment";
// import crypto from "crypto";

import { videoToken, ChatGrant, generateToken } from "./tokens";
import { configureTwilio } from './Twilio';

// import qs from 'qs';
import {
    Conference, ConferenceT,
    Role, RoleT,
    TextChat, TextChatT,
    VideoRoom, VideoRoomT
} from "./SchemaTypes";

import * as Video from "./Video";
import { handleCreateChat, handleGenerateFreshToken } from "./Chat";

// Initialise the Express app
const app = Express();
// Cross-Origin Resource Sharing
app.use(CORS());

// TODO: This app has to initialise and pick up whatever conference state has
// formed inside Twilio and make our data match up. E.g. chats and video rooms
// may have been created while this was offline, or a request might come in for
// a conference we haven't seen yet.
// It also needs to be able to configure conferences to use ngrok at first
// startup.

// TODO: 'onMemberAdd' to Announcements channel
//       - set role (according to admin status) by sending 'modify' response
//         back to Twilio

// TODO: 'onMemberAdded' for detecting sticky-shift into 'large channel' mode

// TODO: 'onMessageSent' / 'onMessageUpdated' / 'onMessageRemoved' / 'onMediaMessageSent'
//       for (large) channel mirroring

// TODO: 'onChannelUpdated' / 'onChannelDestroyed' for (large) channel mirroring

// TODO: Make sure any existing conference's chat service are configured with the
//       above hooks list.
// TODO: How do we keep the above hooks list consistent with the 'create conference' code?

// TODO: 'onUserAdded' - ensure role and friendly name are set correctly

/**********************
 * Twilio callback(s) *
 **********************/

async function processTwilioEvent(req: Express.Request, res: Express.Response) {
    //     let roomSID = req.body.RoomSid;
    //     console.log("Twilio event: " + req.body.StatusCallbackEvent + " " + req.body.RoomSid)
    //     try {
    //         if (req.body.StatusCallbackEvent === 'room-ended') {
    //             let roomQ = new Parse.Query(VideoRoom);
    //             roomQ.equalTo("twilioID", roomSID);
    //             let room = await roomQ.first({ useMasterKey: true });
    //             if (room) {
    //                 if (!room.get("ephemeral")) {
    //                     console.log(`Removing Twilio room ID for ${room.get("name")}`)
    //                     room.set("twilioID", "");
    //                     await room.save({}, { useMasterKey: true });
    //                 } else {
    //                     await room.destroy({ useMasterKey: true });
    //                 }
    //             } else {
    //                 console.warn(`Unable to destroy room ${roomSID} because it doesn't exist in Parse.`);
    //             }
    //         }
    //     } catch (err) {
    //         console.error("Error processing Twilio event", err);
    //     }

    //     console.log("DONE Twilio event: " + req.body.StatusCallbackEvent + " " + req.body.RoomSid);

    res.send();
}

app.post("/twilio/chat/event", BodyParser.json(), BodyParser.urlencoded({ extended: false }), async (req, res) => {
    try {
        await processTwilioEvent(req, res);
    } catch (e) {
        console.log(e);
    }
})


/************************
 * Moderation endpoints *
 ************************/

// app.post("/moderator/fromVideo", BodyParser.json(), BodyParser.urlencoded({ extended: false }), async (req, res) => {
//     try {
//         await sendModeratorMessage(req, res);
//     } catch (err) {
//         res.status(500);
//         res.send({ status: "error", message: "An internal server error occurred." })
//         console.error(err);
//     }
// })

// app.post("/video/acl", BodyParser.json(), BodyParser.urlencoded({ extended: false }), async (req, res) => {
//     await updateACL(req, res);
// })

// app.post('/users/ban', BodyParser.json(), BodyParser.urlencoded({ extended: false }), async (req, res, next) => {
//     const identity = req.body.identity;
//     const profileToBan = req.body.profileID;
//     const isBan = req.body.isBan;
//     let conf = await getConference(req.body.conference);
//     try {
//         const hasAccess = await sessionTokenIsFromModerator(identity, conf.id);
//         if (!hasAccess) {
//             res.status(403);
//             res.send();
//             return;
//         }
//         let profileQ = new Parse.Query(UserProfile);
//         profileQ.include("user");
//         let profile = await profileQ.get(profileToBan, { useMasterKey: true });
//         if (isBan) {
//             profile.set("isBanned", true);
//             let bannedACL = new Parse.ACL();
//             bannedACL.setWriteAccess(profile.get("user"), false);
//             bannedACL.setRoleReadAccess(conf.id + "-conference", true);
//             profile.setACL(bannedACL);
//             await profile.save({}, { useMasterKey: true });

//             //Deny user read access to their own record
//             let user = profile.get("user");
//             let bannedUserACL = new Parse.ACL();
//             user.setACL(bannedUserACL);
//             await user.save({}, { useMasterKey: true });
//         } else {
//             profile.set("isBanned", false);
//             let notBannedACL = new Parse.ACL();
//             notBannedACL.setWriteAccess(profile.get("user"), true);
//             notBannedACL.setRoleReadAccess(conf.id + "-conference", true);

//             profile.setACL(notBannedACL);
//             await profile.save({}, { useMasterKey: true });
//             let user = profile.get("user");

//             let userACL = new Parse.ACL();
//             userACL.setWriteAccess(user, true);
//             userACL.setReadAccess(user, true);
//             user.setACL(userACL);
//             await user.save({}, { useMasterKey: true });

//         }
//         await pushToUserStream(profile.get("user"), conf, "profile");
//         res.send({ status: "OK" });
//     } catch (err) {
//         res.status(500);
//         console.error(err);
//         res.send({ status: "error", message: "Internal server error, please check logs" })
//     }
//     // newNode[uid] = true;
//     // let membersRef = roomRef.child("members").child(uid).set(true).then(() => {
//     // });
// });


/******************
 * Chat endpoints *
 ******************/

app.post('/chat/token',
    BodyParser.json(),
    BodyParser.urlencoded({ extended: false }),
    handleGenerateFreshToken);

app.post('/chat/create',
    BodyParser.json(),
    BodyParser.urlencoded({ extended: false }),
    handleCreateChat);

// // TODO: Can't we control this through Twilio permissions?
// app.post('/chat/deleteMessage', BodyParser.json(), BodyParser.urlencoded({ extended: false }), async (req, res, next) => {
//     const identity = req.body.identity;
//     const messageSID = req.body.message;
//     const channelSID = req.body.room;
//     try {
//         const hasAccess = await sessionTokenIsFromModerator(identity, req.body.conference);
//         let conf = await getConference(req.body.conference);
//         if (!hasAccess) {
//             res.status(403);
//             res.send();
//             return;
//         }
//         let chat = await conf.Twilio.chat.services(conf.config.TWILIO_CHAT_SERVICE_SID).channels(channelSID).messages(messageSID).remove();
//         res.send({ status: "OK" });
//     } catch (err) {
//         next(err);
//     }
//     // newNode[uid] = true;
//     // let membersRef = roomRef.child("members").child(uid).set(true).then(() => {
//     // });
// });


/*******************
 * Video endpoints *
 *******************/

// app.post("/video/token", BodyParser.json(), BodyParser.urlencoded({ extended: false }), async (req, res) => {
//     try {
//         await mintTokenForFrontend(req, res);
//     } catch (err) {
//         console.log("Not found when minting")
//         console.error(err);
//         res.status(500);
//         res.send({ status: "error", message: "Internal server error" });
//     }
// });

// app.post("/video/new", BodyParser.json(), BodyParser.urlencoded({ extended: false }), async (req, res) => {
//     return await Video.createNewRoom(req, res);
// });

// app.post('/video/deleteRoom', BodyParser.json(), BodyParser.urlencoded({ extended: false }), async (req, res, next) => {
//     const identity = req.body.identity;
//     const roomID = req.body.room;
//     let conf = await getConference(req.body.conference);
//     try {
//         const hasAccess = await sessionTokenIsFromModerator(identity, conf.id);
//         if (!hasAccess) {
//             res.status(403);
//             res.send();
//             return;
//         }
//         //First, remove all users.
//         let roomQ = new Parse.Query(BreakoutRoom);
//         let room = await roomQ.get(roomID, { useMasterKey: true });
//         if (!room) {
//             console.log("Unable to find room:" + roomID)
//         }
//         let promises = [];
//         if (room.get("members")) {
//             for (let member of room.get("members")) {
//                 console.log("Kick: " + member.id);
//                 promises.push(removeFromCall(conf.Twilio, room.get("twilioID"), member.id));
//             }
//         }
//         await Promise.all(promises);
//         await room.destroy({ useMasterKey: true });
//         res.send({ status: "OK" });
//     } catch (err) {
//         next(err);
//     }
//     // newNode[uid] = true;
//     // let membersRef = roomRef.child("members").child(uid).set(true).then(() => {
//     // });
// });



/**********
 * Server *
 **********/

async function runBackend() {
    // Check we have all the required environment keys for Parse
    assert(process.env.REACT_APP_PARSE_APP_ID,
        "REACT_APP_PARSE_APP_ID not provided.");
    assert(process.env.REACT_APP_PARSE_JS_KEY,
        "REACT_APP_PARSE_JS_KEY not provided.");
    assert(process.env.PARSE_MASTER_KEY,
        "PARSE_MASTER_KEY not provided.");
    assert(process.env.REACT_APP_PARSE_DATABASE_URL,
        "REACT_APP_PARSE_DATABASE_URL not provided.");

    // Initialise Parse
    Parse.initialize(
        process.env.REACT_APP_PARSE_APP_ID,
        process.env.REACT_APP_PARSE_JS_KEY,
        process.env.PARSE_MASTER_KEY
    );
    Parse.serverURL = process.env.REACT_APP_PARSE_DATABASE_URL;

    let promises: Array<Promise<any>> = [];

    if ((process.env.TWILIO_BACKEND_SKIP_INIT || "false") === "false") {
        let query = new Parse.Query(Conference);
        query.find({ useMasterKey: true }).then((instances) => {
            promises = instances.map(
                async (conf) => {
                    const name = conf.get("name");
                    try {
                        // Just 'getting' the conference is sufficient to trigger
                        // configuration - very side effectful.
                        await getConference(conf.id);
                        console.log(`Loaded ${name}.`);
                    } catch (err) {
                        console.error(`Loading ${name} failed.`);
                    }
                    console.log("==========================================");
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

export default runBackend;
