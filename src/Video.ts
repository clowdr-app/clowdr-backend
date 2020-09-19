import Express from 'express';
import { getConfig } from './Config';

import { getConference } from "./ParseHelpers";
import { getTwilioClient } from './Twilio';

// var privilegeRoles = {
//     "createVideoRoom": null,
//     "chat": null,
//     "createVideoRoom-persistent": null,
//     "createVideoRoom-group": null,
//     "createVideoRoom-smallgroup": null,
//     "createVideoRoom-peer-to-peer": null,
//     'createVideoRoom-private': null,
//     "moderator": null
// };

export async function createNewRoom(req: Express.Request, res: Express.Response) {
    let token = req.body.identity;
    let confID = req.body.conference;

    console.log(`[Create new room]: Fetching conference ${confID}`);
    let conf = await getConference(confID);
    if (!conf) {
        console.warn('[Create new room]: Request did not include conference id.');
        return;
    }

    console.log("[Create new room]: Got conference")
    let roomName = req.body.room;

    let config = await getConfig(confID);
    let twilio = await getTwilioClient(confID, config);

    let visibility = req.body.visibility;
    let mode = req.body.mode;
    let persistence = req.body.emphemeral;

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
            const accesToConf = new Parse.Query(ConferencePermission);
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

// async function removeFromCall(Twilio, roomSID, identity) {
//     console.log("Kick: " + identity);
//     try {
//         let participant = await Twilio.video.rooms(roomSID).participants(identity).update({ status: 'disconnected' })
//     } catch (err) {
//         console.error(err);
//         //might not be in room still.
//     }
// }
// var uidToProfileCache = {};

// async function updateACL(req, res) {
//     try {
//         let identity = req.body.identity;
//         const roomID = req.body.roomID;
//         const conference = req.body.conference;
//         const users = req.body.users;
//         let conf = await getConference(conference);
//         let userQ = new Parse.Query(Parse.Session);
//         userQ.equalTo("sessionToken", identity);
//         userQ.include(["user.displayname"]);
//         let parseSession = await userQ.first({ useMasterKey: true });
//         let parseUser = parseSession.get("user");
//         //Check for roles...
//         let roomQ = new Parse.Query("BreakoutRoom");
//         roomQ.include("conversation");
//         let room = await roomQ.get(roomID, { sessionToken: identity });
//         if (!room) {
//             return res.send({ status: 'error', message: "No such room" });
//         }
//         let usersWithAccessCurrently = Object.keys(room.getACL().permissionsById).filter(v => !v.startsWith("role"));

//         let chat = conf.Twilio.chat.services(conf.config.TWILIO_CHAT_SERVICE_SID);

//         let uq = new Parse.Query(Parse.User);
//         let usersToRefresh = [];
//         let promises = [];
//         for (let uid of usersWithAccessCurrently) {
//             let fauxUser = new Parse.User();
//             fauxUser.id = uid;
//             usersToRefresh.push(fauxUser);
//             if (!users.includes(uid)) {
//                 room.getACL().setReadAccess(uid, false);
//                 let user = await uq.get(uid, { useMasterKey: true });
//                 //find the profile for this user, since that's what we want to put into Twilio
//                 let userProfile = await getUserProfile(uid, conf);
//                 promises.push(removeFromCall(conf.Twilio, room.get("twilioID"), userProfile.id));
//                 promises.push(chat.channels(room.get("twilioChatID")).members(userProfile.id).remove().catch(err => console.error(err)));
//             }
//         }
//         for (let user of users) {
//             if (!usersWithAccessCurrently.includes(user)) {

//                 if (room.get("conversation"))
//                     room.get("conversation").getACL().setReadAccess(user, true);
//                 room.getACL().setReadAccess(user, true);
//                 let userProfile = await getUserProfile(user, conf);
//                 promises.push(chat.channels(room.get("twilioChatID")).members.create({ identity: userProfile.id }));
//                 let fauxUser = new Parse.User();
//                 fauxUser.id = user;
//                 usersToRefresh.push(fauxUser);
//             }
//         }
//         if (room.get("conversation")) {
//             await room.get("conversation").save({}, { useMasterKey: true });
//         }
//         if (users.length === 0) {
//             await room.destroy({ useMasterKey: true });
//         } else {
//             await room.save({}, { useMasterKey: true });
//         }
//         await Promise.all(promises);

//         promises = [];
//         for (let user of usersToRefresh) {
//             promises.push(pushToUserStream(user, conf, "privateBreakoutRooms"));
//         }
//         await Promise.all(promises);
//         res.send({ status: "OK" });
//     } catch (err) {
//         console.error(err);
//         res.send({ status: "error", message: "Internal server error" });
//     }
// }

// async function createTwilioRoomForParseRoom(parseRoom, conf) {
//     let twilioRoom = await conf.Twilio.video.rooms.create({
//         type: parseRoom.get("mode"),
//         uniqueName: parseRoom.get("title"),
//         statusCallback: conf.config.TWILIO_CALLBACK_URL
//     });
//     return twilioRoom;
// }

// async function mintTokenForFrontend(req, res) {
//     let identity = req.body.identity;
//     console.log("Token requested by " + identity)
//     const room = req.body.room;
//     const conference = req.body.conference;
//     let conf = await getConference(conference);
//     if (!conf.config.TWILIO_ACCOUNT_SID) {
//         res.status(403);
//         console.log("Received invalid conference request: ");
//         console.log(req.body);
//         res.send({ status: "error", message: "Conference not configured." })
//         return;
//     }
//     let userQ = new Parse.Query(Parse.Session);
//     userQ.equalTo("sessionToken", identity);
//     // userQ.include(["user.displayname"]);
//     // console.log(identity)
//     let parseSession = await userQ.first({ useMasterKey: true });
//     let parseUser = parseSession.get("user");
//     let userProfileQ = new Parse.Query(UserProfile);
//     userProfileQ.equalTo("user", parseUser);
//     userProfileQ.equalTo("conference", conf);
//     let userProfile = await userProfileQ.first({ useMasterKey: true });
//     identity = userProfile.id;

//     // console.log("Get token for video for " + identity + " " + room)
//     if (!room) {
//         res.status(404);
//         res.error();
//     }
//     let query = new Parse.Query("BreakoutRoom");
//     let roomData = await query.get(room, { sessionToken: req.body.identity });
//     if (!roomData.get("twilioID")) {
//         if (roomData.get("persistence") === "persistent") {
//             //Create a new Twilio room
//             try {
//                 let twilioRoom = await createTwilioRoomForParseRoom(roomData, conf);
//                 roomData.set("twilioID", twilioRoom.sid);
//                 await roomData.save({}, { useMasterKey: true });
//                 sidToRoom[twilioRoom.sid] = roomData;
//             } catch (err) {
//                 //If an error ocurred making the Twilio room, someone else must have updated it.
//                 console.error(err);
//                 let twilioRoom = await conf.Twilio.video.rooms(roomData.get("title")).fetch();
//                 roomData.set("twilioID", twilioRoom.sid)
//                 await roomData.save({}, { useMasterKey: true });
//                 sidToRoom[twilioRoom.sid] = roomData;
//             }
//         } else {
//             res.status(404);
//             return res.send({ message: "This room has been deleted" });
//         }
//     }
//     let newNode = {};
//     if (!roomData) {
//         res.status(403);
//         res.error();
//     }
//     const token = videoToken(identity, roomData.get('twilioID'), conf.config);
//     // console.log("Sent response" + token);
//     sendTokenResponse(token, roomData.get('title'), res);

//     // newNode[uid] = true;
//     // let membersRef = roomRef.child("members").child(uid).set(true).then(() => {
//     // });
// }

function sendTokenResponse(
    token: AccessToken,
    roomName: string,
    res: Express.Response<any>
) {
    res.set('Content-Type', 'application/json');
    res.send(
        JSON.stringify({
            token: token.toJwt(),
            roomName: roomName
        })
    );
};
