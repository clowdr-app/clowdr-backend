import { Request, Response, NextFunction } from 'express';

import { ConferenceT, Role, VideoRoom, VideoRoomT } from './SchemaTypes';

import { generateVideoToken } from "./tokens";

import { callWithRetry, handleRequestIntro } from './RequestHelpers';

import Parse from "parse/node";
import Twilio from "twilio";
import assert from "assert";
import { ClowdrConfig } from './Config';
import { RoomInstance } from 'twilio/lib/rest/video/v1/room';
import { isUserInRoles } from './Roles';

function generateTwilioRoomName(room: VideoRoomT) {
    return room.get("name").substr(0, 128);
}

export async function getRoom(roomId: string, conf: ConferenceT, sessionToken?: string): Promise<VideoRoomT | undefined> {
    const uq = new Parse.Query(VideoRoom);
    uq.equalTo("conference", conf);
    return uq.get(roomId, sessionToken ? { sessionToken } : { useMasterKey: true });
}

export async function handleGenerateFreshToken(req: Request, res: Response, next: NextFunction) {
    try {
        const requestContext = await handleRequestIntro(req, res, next);
        if (!requestContext) {
            return;
        }
        const { sessionToken, sessionObj, conf, config, userProfile } = requestContext;
        const roomId = req.body.room;

        const identity = userProfile.id;
        const sessionID = sessionObj.id;
        if (!roomId) {
            res.status(400);
            res.send({ status: "Missing room id." });
            return;
        }
        // This request will ensure we only get the room if it's part of the same
        // conference as the user profile, and the user has ACL rights to it.
        let room;
        try {
            room = await getRoom(roomId, conf, sessionToken);
        }
        catch (e) {
            if (e.toString().toLowerCase().includes("object not found")) {
                res.status(400);
                res.send({ status: "Invalid room." });
                return;
            }
            else {
                throw e;
            }
        }
        if (!room) {
            res.status(400);
            res.send({ status: "Invalid room." });
            return;
        }

        console.log(`${new Date().toUTCString()} [/video/token]: User: '${userProfile.get("displayName")}' (${userProfile.id}), Conference: '${conf.get("name")}' (${conf.id}), Room: '${roomId}'`);

        let twilioRoomId = room.get("twilioID");
        if (!twilioRoomId) {
            // Create the room in Twilio

            const accountSID = config.TWILIO_ACCOUNT_SID;
            const accountAuth = config.TWILIO_AUTH_TOKEN;
            const twilioClient = Twilio(accountSID, accountAuth);

            let twilioRoom: RoomInstance;
            try {
                twilioRoom = await createTwilioRoom(room, config, twilioClient);
            } catch (err) {
                // If an error ocurred making the Twilio room, someone else might have updated it.
                try {
                    twilioRoom = await twilioClient.video.rooms(generateTwilioRoomName(room)).fetch();
                }
                catch (innerErr) {
                    console.error(`Error creating Twilio room: ${err}`);
                    res.status(500);
                    res.send({ status: "Could not create or get Twilio room." });
                    return;
                }
            }

            twilioRoomId = twilioRoom.sid;
            room.set("twilioID", twilioRoomId);
            await room.save(null, { useMasterKey: true });
        }

        assert(twilioRoomId);

        // TODO: Put Twilio token TTL (time-to-live) into configuration in database
        const expiryDistanceSeconds = 3600 * 4;
        const accessToken = generateVideoToken(config, identity, twilioRoomId, expiryDistanceSeconds);
        res.set('Content-Type', 'application/json');
        res.send(JSON.stringify({
            token: accessToken.toJwt(),
            identity,
            twilioRoomId,
            roomName: generateTwilioRoomName(room),
            expiry: new Date().getTime() + (expiryDistanceSeconds * 1000)
        }));
    } catch (err) {
        next(err);
    }
}

async function createTwilioRoom(room: VideoRoomT, config: ClowdrConfig, twilioClient: Twilio.Twilio) {
    console.log(`Creating Twilio room for VideoRoom: ${room.id}`);
    const result = await twilioClient.video.rooms.create({
        type: "group",
        uniqueName: generateTwilioRoomName(room),
        maxParticipants: room.get("capacity"),
        statusCallback: config.TWILIO_VIDEO_WEBHOOK_URL
    });
    console.log(`Twilio room created: ${result.sid}`);
    return result;
}

export async function handleDeleteVideoRoom(req: Request, res: Response, next: NextFunction) {
    try {
        const requestContext = await handleRequestIntro(req, res, next);
        if (!requestContext) {
            return;
        }
        const { sessionObj, conf, config, userProfile } = requestContext;
        const roomId = req.body.room;

        console.log(`${new Date().toUTCString()} [/video/token]: User: '${userProfile.get("displayName")}' (${userProfile.id}), Conference: '${conf.get("name")}' (${conf.id}), Room: '${roomId}'`);

        if (!roomId) {
            res.status(400);
            res.send({ status: "Missing room id." });
            return;
        }
        // This request will ensure we only get the room if it's part of the same
        // conference as the user profile.
        const room = await getRoom(roomId, conf);
        if (!room) {
            res.status(400);
            res.send({ status: "Invalid room." });
            return;
        }

        if (!isUserInRoles(sessionObj.get("user").id, conf.id, ["admin", "manager"])) {
            res.status(403);
            res.send({ status: "Permission denied." });
            return;
        }

        const twilioRoomID = room.get("twilioID");
        if (twilioRoomID) {
            // First, kick all the room's participants.

            const accountSID = config.TWILIO_ACCOUNT_SID;
            const accountAuth = config.TWILIO_AUTH_TOKEN;
            const twilioClient = Twilio(accountSID, accountAuth);

            const participants = await twilioClient.video.rooms(twilioRoomID).participants.list();
            await Promise.all(participants.map(async participant => {
                try {
                    console.log(`Kick participant ${participant.identity} from ${twilioRoomID} (${generateTwilioRoomName(room)})`);
                    await participant.update({ status: "disconnected" });
                }
                catch (e) {
                    // Might have left the room in the interveaning time
                }
            }));
        }

        await room.destroy({ useMasterKey: true });
        res.send({ status: "OK" });
    } catch (err) {
        next(err);
    }
}


//////// Old system code ////////

// // var privilegeRoles = {
// //     "createVideoRoom": null,
// //     "chat": null,
// //     "createVideoRoom-persistent": null,
// //     "createVideoRoom-group": null,
// //     "createVideoRoom-smallgroup": null,
// //     "createVideoRoom-peer-to-peer": null,
// //     'createVideoRoom-private': null,
// //     "moderator": null
// // };

// export async function createNewRoom(req: Express.Request, res: Express.Response) {
//     const token = req.body.identity;
//     const confID = req.body.conference;

//     console.log(`[Create new room]: Fetching conference ${confID}`);
//     const conf = await getConference(confID);
//     if (!conf) {
//         console.warn('[Create new room]: Request did not include conference id.');
//         return;
//     }

//     console.log("[Create new room]: Got conference")
//     const roomName = req.body.room;

//     const config = await getConfig(confID);
//     const twilio = await getTwilioClient(confID, config);

//     const visibility = req.body.visibility;
//     let mode = req.body.mode;
//     let persistence = req.body.emphemeral;

//     const socialSpaceID = req.body.socialSpace;
//     if (!mode)
//         mode = "group-small";
//     if (!persistence)
//         persistence = "ephemeral";


//     try {
//         const query = new Parse.Query(Parse.Session);
//         // console.log(token);
//         query.include("user");
//         query.equalTo("sessionToken", token);
//         const session = await query.first({ useMasterKey: true });
//         console.log("Create new room: Got user from session token")
//         if (session) {
//             const parseUser = session.get("user");
//             // Validate has privileges for conference
//             const accesToConf = new Parse.Query(ConferencePermission);
//             accesToConf.equalTo("conference", conf);
//             accesToConf.equalTo("action", privilegeRoles.createVideoRoom);
//             console.log('--> ' + JSON.stringify(privilegeRoles.createVideoRoom));
//             // TODO access-check for each option, too, but I don't have time now...
//             const hasAccess = await accesToConf.first({ sessionToken: token });
//             console.log('Permission to create video room? ' + hasAccess);
//             if (hasAccess && hasAccess.id) {
//                 // Try to create the room
//                 try {
//                     console.log("creating room with callback" + conf.config.TWILIO_CALLBACK_URL)
//                     console.log("For " + parseUser.id + ": " + parseUser.get("displayname"))
//                     console.log(roomName)
//                     const maxParticipants = (mode === "peer-to-peer" ? 10 : (mode === "group-small" ? 4 : 10));
//                     const twilioRoom = await twilio.video.rooms.create({
//                         type: mode,
//                         uniqueName: roomName,
//                         maxParticipants,
//                         statusCallback: conf.config.TWILIO_CALLBACK_URL
//                     });
//                     // Create a chat room too

//                     const chat = twilio.chat.services(conf.config.TWILIO_CHAT_SERVICE_SID);


//                     // Create a new room in the DB
//                     const parseRoom = new BreakoutRoom();
//                     parseRoom.set("title", roomName);
//                     parseRoom.set("conference", conf);
//                     parseRoom.set("twilioID", twilioRoom.sid);
//                     parseRoom.set("isPrivate", visibility === "unlisted");
//                     parseRoom.set("persistence", persistence);
//                     parseRoom.set("mode", mode);
//                     parseRoom.set("capacity", maxParticipants);
//                     if (socialSpaceID) {
//                         const socialSpace = new SocialSpace();
//                         socialSpace.id = socialSpaceID;
//                         parseRoom.set("socialSpace", socialSpace);
//                     }
//                     const modRole = await getOrCreateRole(conf.id, "moderator");

//                     const acl = new Parse.ACL();
//                     acl.setPublicReadAccess(false);
//                     acl.setPublicWriteAccess(false);
//                     acl.setRoleReadAccess(modRole, true);
//                     if (visibility === "unlisted") {
//                         acl.setReadAccess(parseUser.id, true);
//                     }
//                     else {
//                         acl.setRoleReadAccess(await getOrCreateRole(conf.id, "conference"), true);
//                     }
//                     parseRoom.setACL(acl, { useMasterKey: true });
//                     await parseRoom.save({}, { useMasterKey: true });
//                     const attributes = {
//                         category: "breakoutRoom",
//                         roomID: parseRoom.id
//                     }

//                     const twilioChatRoom = await chat.channels.create({
//                         friendlyName: roomName,
//                         attributes: JSON.stringify(attributes),
//                         type:
//                             (visibility === "unlisted" ? "private" : "public")
//                     });
//                     if (visibility === "unlisted") {
//                         // give this user access to the chat
//                         const userProfile = await getUserProfile(parseUser.id, conf);
//                         console.log("Creating chat room for " + roomName + " starting user " + userProfile.id)
//                         await chat.channels(twilioChatRoom.sid).members.create({ identity: userProfile.id });
//                         // Make sure that all moderators and admins have access to this room, too.
//                         const modRole = await getOrCreateRole(conf.id, "moderator");
//                         const userQuery = modRole.getUsers().query();
//                         const profilesQuery = new Parse.Query(UserProfile);
//                         profilesQuery.equalTo("conference", conf);
//                         profilesQuery.matchesQuery("user", userQuery);
//                         profilesQuery.find({ useMasterKey: true }).then((users) => {
//                             for (const user of users) {
//                                 chat.channels(twilioChatRoom.sid).members.create({ identity: user.id });
//                             }
//                         })
//                     }
//                     parseRoom.set("twilioChatID", twilioChatRoom.sid);
//                     await parseRoom.save({}, { useMasterKey: true });
//                     sidToRoom[twilioRoom.sid] = parseRoom;
//                     conf.rooms.push(parseRoom);
//                     return res.send({ status: "OK" });
//                 } catch (err) {
//                     console.error(err);
//                     return res.send({
//                         status: "error",
//                         message: "There is already a video room with this name (although it may be private, and you can't see it). Please either join the existing room or pick a new name."
//                     });
//                 }
//             } else {
//                 return res.send({
//                     status: "error",
//                     message: "Sorry, you do not currently have access to create video rooms for " + conf.get("conferenceName")
//                 });
//             }

//         }
//     } catch (err) {
//         console.error(err);
//         return res.send({ status: "error", message: "Internal server error " });
//     }
//     return res.send({
//         status: "error",
//         message: "Could not find enrollment for this user on this conference, " + conf
//     });
// }


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
