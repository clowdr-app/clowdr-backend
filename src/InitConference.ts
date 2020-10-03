import Parse from "parse/node";
import { ConferenceT } from "./SchemaTypes";

// async function populateActiveChannels(conf: ConferenceT) {
//     let roomQuery = new Parse.Query(VideoRoom);
//     roomQuery.equalTo("conference", conf);
//     let rooms = await roomQuery.find({ useMasterKey: true });
//     return rooms;
// }

export async function initChatRooms(r: ConferenceT) {
    // TODO: initChatRooms
    // TODO: This function should verify what actually needs doing

    // try {
    //     r.rooms = await populateActiveChannels(r);
    //     r.config = await getConfig(r);

    //     try {
    //         r.Twilio = Twilio(r.config.TWILIO_ACCOUNT_SID, r.config.TWILIO_AUTH_TOKEN);
    //     } catch (err) {
    //         console.log(`[initChatRooms]: failed to connect to Twilio with account ${r.config.TWILIO_ACCOUNT_SID} and auth token ${r.config.TWILIO_AUTH_TOKEN}. Check your credentials`);
    //         return;
    //     }

    //     if (!r.config.TWILIO_CHAT_SERVICE_SID) {
    //         let newChatService = await r.Twilio.chat.services.create({ friendlyName: 'clowdr_chat' });
    //         await addOrReplaceConfig(r, "TWILIO_CHAT_SERVICE_SID", newChatService.sid);
    //     }

    //     let socialSpaceQ = new Parse.Query("SocialSpace");
    //     socialSpaceQ.equalTo("conference", r);
    //     socialSpaceQ.equalTo("name", "Lobby");
    //     r.lobbySocialSpace = await socialSpaceQ.first({ useMasterKey: true });

    //     //Make sure that there is a record of the instance for enrollments
    //     let accessQ = new Parse.Query(ConferenceAccess);
    //     accessQ.equalTo("conference", r);
    //     let accessRecord = await accessQ.first({ useMasterKey: true });
    //     if (!accessRecord) {
    //         accessRecord = new ConferenceAccess();
    //         let role = await getOrCreateRole(r.id, "conference");
    //         let acl = new Parse.ACL();
    //         try {
    //             acl.setRoleReadAccess(r.id + "-conference", true);
    //             accessRecord.set("conference", r);
    //             accessRecord.setACL(acl);
    //             await accessRecord.save({}, { useMasterKey: true });
    //         } catch (err) {
    //             console.log("on room " + r.id)
    //             console.error(err);
    //         }
    //     }

    //     //This is the first time we hit this conference on this run, so we should also grab the state of the world from Twilio

    //     let roomsInTwilio = await r.Twilio.video.rooms.list();

    //     let modRole = await getOrCreateRole(r.id, "moderator");

    //     for (let room of roomsInTwilio) {
    //         if (room.status === 'in-progress') {
    //             if (r.rooms.filter((i) => i.get("twilioID") === room.sid).length === 0) {
    //                 //make a new room with room.uniqueName
    //                 let parseRoom = new BreakoutRoom();
    //                 parseRoom.set("conference", r);
    //                 parseRoom.set("twilioID", room.sid);
    //                 parseRoom.set("title", room.uniqueName);
    //                 parseRoom.set("persistence", "ephemeral");
    //                 parseRoom = await parseRoom.save();
    //                 let acl = new Parse.ACL();
    //                 acl.setPublicReadAccess(false);
    //                 acl.setPublicWriteAccess(false);
    //                 acl.setRoleReadAccess(modRole, true);
    //                 acl.setRoleReadAccess(await getOrCreateRole(r.id, "conference"), true);
    //                 parseRoom.setACL(acl, { useMasterKey: true });
    //                 await parseRoom.save({}, { useMasterKey: true });
    //                 sidToRoom[room.sid] = parseRoom;
    //                 r.rooms.push(parseRoom);
    //             }
    //         }
    //     }

    //     for (let parseRoom of r.rooms) {
    //         try {
    //             if (!parseRoom.get("twilioID") && parseRoom.get("persistence") !== "ephemeral")
    //                 continue; //persistent room, not occupied.
    //             let found = roomsInTwilio.filter((i) => i.status === 'in-progress' && i.sid === parseRoom.get("twilioID"));
    //             if (found.length === 1 && found[0].status === 'in-progress') {
    //                 sidToRoom[parseRoom.get("twilioID")] = parseRoom;
    //                 //sync members
    //                 let participants = await r.Twilio.video.rooms(parseRoom.get("twilioID")).participants.list();
    //                 for (let participant of participants) {
    //                     let uid = participant.identity;
    //                     let userFindQ = new Parse.Query(UserProfile);
    //                     try {
    //                         let user = await userFindQ.get(uid, { useMasterKey: true });
    //                         if (!parseRoom.get("members")) {
    //                             parseRoom.set("members", [user]);
    //                         } else {
    //                             if (parseRoom.get("members").filter((u) => u.id === uid).length === 0)
    //                                 parseRoom.get("members").push(user);
    //                         }
    //                     } catch (err) {
    //                         console.log("Missing participant: " + uid)
    //                         console.error(err);
    //                     }
    //                 }
    //                 let membersToRemove = [];
    //                 if (parseRoom.get("members")) {
    //                     for (let member of parseRoom.get("members")) {
    //                         let found = participants.filter((p) => {
    //                             let uid = p.identity;
    //                             return uid === member.id && p.status === "connected";
    //                         });
    //                         if (found.length === 0) {
    //                             //remove that member
    //                             membersToRemove.push(member.id);
    //                         }
    //                     }
    //                     let newMembers = parseRoom.get("members").filter((member) => !membersToRemove.includes(member.id));
    //                     parseRoom.set("members", newMembers);
    //                 }
    //                 await parseRoom.save({}, { useMasterKey: true });
    //             } else {
    //                 //room no logner exists
    //                 try {
    //                     if (parseRoom.get("persistence") === "persistent") {
    //                         parseRoom.set("twilioID", null);
    //                         await parseRoom.save({}, { useMasterKey: true });
    //                     } else {
    //                         if (parseRoom.get("twilioChatID")) {
    //                             await r.Twilio.chat.services(r.config.TWILIO_CHAT_SERVICE_SID).channels(parseRoom.get("twilioChatID")).remove();
    //                         }
    //                         await parseRoom.destroy({ useMasterKey: true });
    //                         r.rooms = r.rooms.filter((r) => r.id !== parseRoom.id);
    //                     }
    //                 } catch (err) {
    //                     console.log("Unable to delete " + parseRoom.id)
    //                     console.error(err);
    //                 }
    //             }
    //         } catch (err) {
    //             console.log("initialization error on " + parseRoom.id)
    //             console.error(err);
    //             console.log(err.stack)
    //         }
    //     }

    //     let adminRole = await getParseAdminRole();
    //     let adminsQ = adminRole.getUsers().query();
    //     adminsQ.limit(1000);
    //     let admins = await adminsQ.find({ useMasterKey: true });
    //     let promises = [];
    //     for (let admin of admins) {
    //         promises.push(ensureUserHasTeamRole(admin, r, await getOrCreateRole(r.id, "conference")));
    //     }

    //     await Promise.all(promises).catch((err) => {
    //         console.error(err);
    //     });
    // } catch (err) {
    //     console.log('[getConference]: outter err: ' + err);
    // }
}

// const userToWorkspaces = {};
// async function ensureUserHasTeamRole(user, conf, role) {
//     let confID = conf.id;
//     // console.trace()
//     if (userToWorkspaces[user.id] && userToWorkspaces[user.id][conf.id]) {
//         return;
//     }
//     let debug = false;
//     try {
//         //Check in DB
//         const roleQuery = new Parse.Query(Parse.Role);
//         roleQuery.equalTo("users", user);
//         roleQuery.equalTo("id", role.id);
//         if (!role.id) {
//             console.log("invalid role?")
//             console.log(role);
//             console.trace();
//         }
//         const roles = await roleQuery.find({ useMasterKey: true });
//         if (!roles || roles.length === 0) {
//             role.getUsers().add(user);
//             let savedRole = await role.save(null, { useMasterKey: true, cascadeSave: true });
//         } else if (debug) {
//             console.log("Already has role? " + user.id)
//         }
//         if (!userToWorkspaces[user.id]) {
//             userToWorkspaces[user.id] = {};
//         }
//         userToWorkspaces[user.id][conf.id] = 1;
//     } catch (err) {
//         console.log("Error in role")
//         console.error(err);
//     }
// }
