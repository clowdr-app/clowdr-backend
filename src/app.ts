"use strict";

import assert from "assert";
import Parse from "parse/node";
import Express, { Request, Response, NextFunction } from 'express';
import CORS from 'cors';
import BodyParser from "body-parser";
import Twilio from "twilio";
// import JWT from 'jsonwebtoken';

import { getConference, getUserProfileByID } from "./ParseHelpers";
import { isUserInRoles } from "./Roles";
import { v4 as uuidv4 } from "uuid";

// import moment from "moment";
// import crypto from "crypto";

// import qs from 'qs';
import {
    Conference, ConferenceT,
    Role, RoleT,
    TextChat, TextChatT,
    UserT,
    VideoRoom, VideoRoomT
} from "./SchemaTypes";

import { handleAddReaction, handleGenerateFreshToken as handleGenerateFreshChatToken, handleRemoveReaction } from "./Chat";
import { handleGenerateFreshToken as handleGenerateFreshVideoToken, handleDeleteVideoRoom } from "./Video";
import { getConfig } from "./Config";

// Initialise the Express app
const app = Express();
// Cross-Origin Resource Sharing
app.use(CORS());

// TODO: This app has to initialise and pick up whatever conference state has
// formed inside Twilio and make our data match up. E.g. chats and video rooms
// may have been created while this was offline.

// TODO: Make sure any existing conference's chat service are configured with the
//       hooks handled in processTwilioChatEvent.
// TODO: How do we keep the hooks list consistent with the 'create conference' code?


/**********************
 * Twilio callback(s) *
 **********************/

async function processTwilioChatEvent(req: Express.Request, res: Express.Response) {
    let status = 200;
    let response = {};

    const twilioAccountSID = req.body.AccountSid;
    const twilioInstanceSID = req.body.InstanceSid;

    switch (req.body.EventType) {
        case "onMemberAdded":
            // TODO: for detecting sticky-shift into 'large channel' mode
            //
            // - When upgrading to mirroring, set these webhooks on the channel:
            // 'onMessageSent' / 'onMessageUpdated'
            // 'onMessageRemoved' / 'onMediaMessageSent'
            // 'onChannelUpdated' / 'onChannelDestroyed'

            {
                const targetUserProfileId = req.body.Identity;
                const targetUserProfile = await getUserProfileByID(targetUserProfileId);
                if (!targetUserProfile) {
                    response = "Invalid target user profile ID.";
                    status = 403;
                    break;
                }

                if (targetUserProfile.get("isBanned")) {
                    const conference = targetUserProfile.get("conference") as ConferenceT;
                    const config = await getConfig(conference.id);
                    const twilioClient = Twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
                    const twilioChatService = twilioClient.chat.services(config.TWILIO_CHAT_SERVICE_SID);
                    await twilioChatService.users(targetUserProfile.id).remove();
                    response = "User is banned.";
                    status = 403;
                    break;
                }
                else {
                    const conference = targetUserProfile.get("conference") as ConferenceT;
                    const config = await getConfig(conference.id);
                    {
                        const expectedTwilioAccountSID = config.TWILIO_ACCOUNT_SID;
                        const expectedTwilioInstanceSID = config.TWILIO_CHAT_SERVICE_SID;
                        assert(twilioAccountSID === expectedTwilioAccountSID, "Unexpected Twilio account SID.");
                        assert(twilioInstanceSID === expectedTwilioInstanceSID, "Unexpected Twilio chat service SID.");
                    }

                    const targetUser = targetUserProfile.get("user") as UserT;
                    const isAdmin = await isUserInRoles(targetUser.id, conference.id, ["admin"]);
                    const isManager = await isUserInRoles(targetUser.id, conference.id, ["manager"]);

                    const twilioClient = Twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
                    const twilioChatService = twilioClient.chat.services(config.TWILIO_CHAT_SERVICE_SID);

                    const roles = await twilioChatService.roles.list();

                    if (req.body.ChannelSid === config.TWILIO_ANNOUNCEMENTS_CHANNEL_SID) {
                        const announcementsAdminRole = roles.find(x => x.friendlyName === "announcements admin");
                        const announcementsUserRole = roles.find(x => x.friendlyName === "announcements user");
                        assert(announcementsAdminRole);
                        assert(announcementsUserRole);

                        const newRoleSid
                            = isAdmin
                                ? announcementsAdminRole.sid
                                : announcementsUserRole.sid;
                        if (req.body.RoleSid !== newRoleSid) {
                            const announcementsTwilioChannelCtx = twilioChatService.channels(config.TWILIO_ANNOUNCEMENTS_CHANNEL_SID);
                            console.log(`Updating ${targetUserProfile.get("displayName")} (${targetUserProfileId}) to announcements channel as ${isAdmin ? "admin" : "user"}.`);

                            await announcementsTwilioChannelCtx.members(targetUserProfile.id).update({
                                roleSid: newRoleSid
                            });
                        }
                    }
                    else {
                        const moderationTextChatQ = new Parse.Query("TextChat");
                        moderationTextChatQ.equalTo("conference", conference);
                        moderationTextChatQ.equalTo("mode", "moderation_hub");
                        const moderationTextChat = await moderationTextChatQ.first({ useMasterKey: true });
                        assert(moderationTextChat);

                        const modHubSID = moderationTextChat.get("twilioID");
                        if (req.body.ChannelSid === modHubSID) {
                            if (isAdmin || isManager) {
                                const channelUserRole = roles.find(x => x.friendlyName === "channel user");
                                assert(channelUserRole);

                                if (req.body.RoleSid !== channelUserRole.sid) {
                                    const moderationTwilioChannelCtx = twilioChatService.channels(modHubSID);
                                    console.log(`Updating ${targetUserProfile.get("displayName")} (${targetUserProfileId}) to moderation hub as user.`);
                                    await moderationTwilioChannelCtx.members(targetUserProfile.id).update({
                                        roleSid: channelUserRole.sid
                                    });
                                }
                            }
                            else {
                                response = "User may not join moderation hub.";
                                status = 403;
                                break;
                            }
                        }
                        else {
                            const channelUserRole = roles.find(x => x.friendlyName === "channel user");
                            const channelAdminRole = roles.find(x => x.friendlyName === "channel admin");
                            assert(channelUserRole);
                            assert(channelAdminRole);
                            const newRoleSid =
                                isAdmin || isManager
                                    ? channelAdminRole.sid
                                    : channelUserRole.sid;
                            if (newRoleSid !== req.body.RoleSid) {
                                const channelCtx = twilioChatService.channels(req.body.ChannelSid);
                                console.log(`Updating ${targetUserProfile.get("displayName")} (${targetUserProfileId}) to ${req.body.ChannelSid} as ${newRoleSid === channelAdminRole.sid ? "admin" : "user"}.`);
                                await channelCtx.members(targetUserProfile.id).update({
                                    roleSid: newRoleSid
                                });
                            }
                        }
                    }
                }
            }
            break;

        case "onUserAdded":
            {
                const targetUserProfileId = req.body.Identity;
                const targetUserProfile = await getUserProfileByID(targetUserProfileId);
                if (!targetUserProfile) {
                    response = "Invalid target user profile ID.";
                    status = 403;
                    break;
                }

                if (targetUserProfile.get("isBanned")) {
                    const conference = targetUserProfile.get("conference") as ConferenceT;
                    const config = await getConfig(conference.id);
                    const twilioClient = Twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
                    const twilioChatService = twilioClient.chat.services(config.TWILIO_CHAT_SERVICE_SID);
                    await twilioChatService.users(targetUserProfile.id).remove();
                    response = "User is banned.";
                    status = 403;
                    break;
                }
                else {
                    const conference = targetUserProfile.get("conference") as ConferenceT;
                    const config = await getConfig(conference.id);
                    {
                        const expectedTwilioAccountSID = config.TWILIO_ACCOUNT_SID;
                        const expectedTwilioInstanceSID = config.TWILIO_CHAT_SERVICE_SID;
                        assert(twilioAccountSID === expectedTwilioAccountSID, "Unexpected Twilio account SID.");
                        assert(twilioInstanceSID === expectedTwilioInstanceSID, "Unexpected Twilio chat service SID.");
                    }

                    const targetUser = targetUserProfile.get("user") as UserT;
                    const isAdmin = await isUserInRoles(targetUser.id, conference.id, ["admin"]);
                    const isManager = await isUserInRoles(targetUser.id, conference.id, ["manager"]);

                    const twilioClient = Twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
                    const twilioChatService = twilioClient.chat.services(config.TWILIO_CHAT_SERVICE_SID);

                    const roles = await twilioChatService.roles.list();
                    const serviceAdminRole = roles.find(x => x.friendlyName === "service admin");
                    assert(serviceAdminRole);

                    if (isAdmin || isManager) {
                        await twilioChatService.users(targetUserProfile.id).update({
                            roleSid: serviceAdminRole.sid
                        });
                    }

                    // Add to Announcements channel if necessary
                    const announcementsTwilioChannelCtx = twilioChatService.channels(config.TWILIO_ANNOUNCEMENTS_CHANNEL_SID);
                    const announcementsMembers = await announcementsTwilioChannelCtx.members.list({
                        identity: targetUserProfile.id
                    });
                    if (announcementsMembers.length === 0) {
                        const announcementsAdminRole = roles.find(x => x.friendlyName === "announcements admin");
                        const announcementsUserRole = roles.find(x => x.friendlyName === "announcements user");
                        assert(announcementsAdminRole);
                        assert(announcementsUserRole);

                        console.log(`Adding ${targetUserProfile.get("displayName")} (${targetUserProfileId}) to announcements channel as ${isAdmin ? "admin" : "user"}.`);
                        try {
                            await announcementsTwilioChannelCtx.members.create({
                                identity: targetUserProfile.id,
                                roleSid: isAdmin
                                    ? announcementsAdminRole.sid
                                    : announcementsUserRole.sid
                            });
                        }
                        catch {
                            try {
                                // UI beat us to it
                                await announcementsTwilioChannelCtx.members(targetUserProfile.id).update({
                                    roleSid: isAdmin
                                        ? announcementsAdminRole.sid
                                        : announcementsUserRole.sid
                                });
                            }
                            catch (e) {
                                console.warn(e);
                            }
                        }
                    }

                    if (isAdmin || isManager) {
                        // Add to Moderation Hub
                        const moderationTextChatQ = new Parse.Query("TextChat");
                        moderationTextChatQ.equalTo("conference", conference);
                        moderationTextChatQ.equalTo("mode", "moderation_hub");
                        const moderationTextChat = await moderationTextChatQ.first({ useMasterKey: true });
                        assert(moderationTextChat);
                        const moderationTwilioChannelCtx = twilioChatService.channels(moderationTextChat.get("twilioID"));

                        const moderationMembers = await moderationTwilioChannelCtx.members.list({
                            identity: targetUserProfile.id
                        });
                        if (moderationMembers.length === 0) {
                            const channelUserRole = roles.find(x => x.friendlyName === "channel user");
                            assert(channelUserRole);

                            console.log(`Adding ${targetUserProfile.get("displayName")} (${targetUserProfileId}) to moderation hub as user.`);
                            try {
                                await moderationTwilioChannelCtx.members.create({
                                    identity: targetUserProfile.id,
                                    roleSid: channelUserRole.sid
                                });
                            }
                            catch {
                                await moderationTwilioChannelCtx.members(targetUserProfile.id).update({
                                    roleSid: channelUserRole.sid
                                });
                            }
                        }
                    }
                }

                // Ensure friendly_name is set properly
                response = {
                    friendlyName: uuidv4()
                };
            }
            break;

        // Large-channel-mirroring (per-channel webhooks)
        case "onMessageSent":
            // TODO: for (large) channel mirroring (set webhook per-channel)
            break;
        case "onMessageUpdated":
            // TODO: for (large) channel mirroring (set webhook per-channel)
            break;
        case "onMessageRemoved":
            // TODO: for (large) channel mirroring (set webhook per-channel)
            break;
        case "onMediaMessageSent":
            // TODO: for (large) channel mirroring (set webhook per-channel)
            break;
        case "onChannelUpdated":
            // TODO: for (large) channel mirroring (set webhook per-channel)
            break;
        case "onChannelDestroyed":
            // TODO: for (large) channel mirroring (set webhook per-channel)
            break;
    }

    res.status(status);
    res.send(response);
}

app.post("/twilio/chat/event", BodyParser.json(), BodyParser.urlencoded({ extended: false }), async (req, res) => {
    try {
        // console.log(`${req.body.EventType} chat event received for: ${req.body.ChannelSid ?? req.body.Identity}`);
        await processTwilioChatEvent(req, res);
        return;
    } catch (e) {
        console.error("Error processing Twilio chat webhook. Rejecting changes.", e);
        res.status(403);
        res.send();
        return;
    }
});


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
    handleGenerateFreshChatToken);

app.post('/chat/react',
    BodyParser.json(),
    BodyParser.urlencoded({ extended: false }),
    handleAddReaction);

app.post('/chat/tcaer',
    BodyParser.json(),
    BodyParser.urlencoded({ extended: false }),
    handleRemoveReaction);

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

async function processTwilioVideoEvent(req: Express.Request, res: Express.Response) {
    const status = 200;
    const response = {};

    const roomSID = req.body.RoomSid;
    try {
        const event = req.body.StatusCallbackEvent;
        if (event === "room-ended") {
            const roomQ = new Parse.Query(VideoRoom);
            roomQ.equalTo("twilioID", roomSID);
            const room = await roomQ.first({ useMasterKey: true });
            if (room) {
                if (!room.get("ephemeral")) {
                    console.log(`Removing Twilio room ID for ${room.get("conference").id}:${room.get("name")}`)
                    room.set("twilioID", "");
                    await room.save(null, { useMasterKey: true });
                } else {
                    await room.destroy({ useMasterKey: true });
                }
            } else {
                console.warn(`Unable to destroy room ${roomSID} because it doesn't exist in Parse.`);
            }
        }
        else if (event === "participant-connected") {
            const roomQ = new Parse.Query(VideoRoom);
            roomQ.equalTo("twilioID", roomSID);
            const room = await roomQ.first({ useMasterKey: true });
            if (room) {
                const participantIds = room.get("participants");
                const connectedProfileId = req.body.ParticipantIdentity;
                if (!participantIds.includes(connectedProfileId)) {
                    await room.save({
                        participants: [...participantIds, connectedProfileId]
                    }, {
                        useMasterKey: true
                    });
                }
            }
        }
        else if (event === "participant-disconnected") {
            const roomQ = new Parse.Query(VideoRoom);
            roomQ.equalTo("twilioID", roomSID);
            const room = await roomQ.first({ useMasterKey: true });
            if (room) {
                const participantIds = room.get("participants");
                const disconnectedProfileId = req.body.ParticipantIdentity;
                if (participantIds.includes(disconnectedProfileId)) {
                    await room.save({
                        participants: participantIds.filter(x => x !== disconnectedProfileId)
                    }, {
                        useMasterKey: true
                    });
                }
            }
        }
    } catch (err) {
        console.error("Error processing Twilio video event", err);
    }

    res.status(status);
    res.send(response);
}

app.post("/twilio/video/event", BodyParser.json(), BodyParser.urlencoded({ extended: false }), async (req, res) => {
    try {
        // console.log(`${req.body.StatusCallbackEvent} video event received for: ${req.body.RoomSid ?? req.body.Identity}`);
        await processTwilioVideoEvent(req, res);
        return;
    } catch (e) {
        console.error("Error processing Twilio video webhook. Rejecting changes.", e);
        res.status(403);
        res.send();
        return;
    }
});

app.post('/video/token',
    BodyParser.json(),
    BodyParser.urlencoded({ extended: false }),
    handleGenerateFreshVideoToken);

app.post('/video/delete',
    BodyParser.json(),
    BodyParser.urlencoded({ extended: false }),
    handleDeleteVideoRoom);



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
        const query = new Parse.Query(Conference);
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
                        console.error(`Loading ${name} failed.`, err);
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
