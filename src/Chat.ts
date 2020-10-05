import Parse from "parse/node";
import { Request, Response, NextFunction } from 'express';

import { generateChatToken } from "./tokens";

import { callWithRetry, handleRequestIntro } from './RequestHelpers';
import { getUserProfileByID } from './ParseHelpers';

import Twilio from "twilio";
import { UserProfileT } from './SchemaTypes';

import { v4 as uuidv4 } from "uuid";
import assert from "assert";
import { ServiceContext } from 'twilio/lib/rest/chat/v2/service';
import { getTwilioClient } from "./Twilio";

export async function handleGenerateFreshToken(req: Request, res: Response, next: NextFunction) {
    try {
        const requestContext = await handleRequestIntro(req, res, next);
        if (!requestContext) {
            return;
        }
        const { sessionObj, conf, config, userProfile } = requestContext;

        console.log(`${new Date().toUTCString()} [/chat/token]: User: '${userProfile.get("displayName")}' (${userProfile.id}), Conference: '${conf.get("name")}' (${conf.id})`);

        const identity = userProfile.id;
        const sessionID = sessionObj.id;

        // TODO: Put Twilio token TTL (time-to-live) into configuration in database
        const expiryDistanceSeconds = 3600 * 3;
        const accessToken = generateChatToken(config, identity, sessionID, expiryDistanceSeconds);
        res.set('Content-Type', 'application/json');
        res.send(JSON.stringify({
            token: accessToken.toJwt(),
            identity,
            expiry: new Date().getTime() + (expiryDistanceSeconds * 1000)
        }));
    } catch (err) {
        next(err);
    }
}

async function ensureTwilioUsersExist(service: ServiceContext, profiles: Array<UserProfileT>) {
    const existingUserProfileIds = (await service.users.list()).map(x => x.identity);
    await Promise.all(profiles.map(x => {
        if (!existingUserProfileIds.includes(x.id)) {
            // TODO: Rely on `onUserAdded` to set their service-level role correctly (e.g. for admin users)
            return service.users.create({
                identity: x.id,
                friendlyName: x.get("displayName")
            });
        }
        return null;
    }));
}

// TODO: Ensure we extract common functionality (e.g. adding members to a channel)
//       into functions.

/**
 * Request body:
 *  - identity: session token
 *  - conference: conference id
 *  - invite: user profile ids to invite
 *  - mode: 'public' or 'private'
 *  - title: friendly name
 */
export async function handleCreateChat(req: Request, res: Response, next: NextFunction) {
    try {
        /*
         * DM = Private channel with 1 invited member.
         * Private group = Private channel with at least 2 invited members.
         * Public group = Public channel with 1 or more invited members.
         *
         * (Invalid to have 0 invited members.)
         */

        const requestContext = await handleRequestIntro(req, res, next);
        if (!requestContext) {
            return;
        }
        const { conf, config, userProfile } = requestContext;

        const _userProfileIdsToInvite = req.body.invite;
        const mode = req.body.mode;
        let title = req.body.title?.trim();

        // Validate inputs
        if (!_userProfileIdsToInvite || !title || title === "" || !mode) {
            res.status(400);
            res.send({ status: "Missing request parameter(s)." });
            return;
        }

        if (!(_userProfileIdsToInvite instanceof Array)) {
            res.status(400);
            res.send({ status: "Invited members should be an array." });
            return;
        }

        for (const inviteId of _userProfileIdsToInvite) {
            if (typeof inviteId !== "string") {
                res.status(400);
                res.send({ status: "Invited member ids should be strings." });
                return;
            }
        }

        const userProfileIdsToInvite = _userProfileIdsToInvite.filter(x => x !== userProfile.id) as string[];

        if (userProfileIdsToInvite.length === 0) {
            res.status(400);
            res.send({ status: "Invited members should be a non-empty array (not including the creator)." });
            return;
        }

        if (mode !== "public" && mode !== "private") {
            res.status(400);
            res.send({ status: "Mode should be 'public' or 'private'." });
            return;
        }

        if (typeof title !== "string" || title.trim().length < 5) {
            res.status(400);
            res.send({ status: "Title should be a trimmed string of at least 5 non-empty characters." });
            return;
        }

        title = title.trim();

        const _userProfilesToInvite = await Promise.all(
            userProfileIdsToInvite.map(async id => {
                return getUserProfileByID(id, conf);
            }));

        const usersValid = _userProfilesToInvite.every(x => !!x);
        if (!usersValid) {
            res.status(400);
            res.send({ status: "Users to invite invalid." });
            return;
        }
        const userProfilesToInvite = _userProfilesToInvite as Array<UserProfileT>;

        const isPrivate = mode === "private";
        const isDM = isPrivate && userProfilesToInvite.length === 1;
        // Twilio max-length 64 chars
        const uniqueName
            = (isDM
                ? (userProfile.id.localeCompare(userProfilesToInvite[0].id) === -1
                    ? userProfile.id + "-" + userProfilesToInvite[0].id
                    : userProfilesToInvite[0].id + "-" + userProfile.id)
                : (userProfile.id + "-" + uuidv4()))
                .substr(0, 64);
        const friendlyName = isDM ? uniqueName : title;
        const createdBy = isDM ? "system" : userProfile.id;
        const attributes = {
            isDM
        };

        const accountSID = config.TWILIO_ACCOUNT_SID;
        const accountAuth = config.TWILIO_AUTH_TOKEN;
        const twilioClient = Twilio(accountSID, accountAuth);
        const serviceSID = config.TWILIO_CHAT_SERVICE_SID;

        const existingChannels
            = isDM
                ? (await twilioClient.chat
                    .services(serviceSID)
                    .channels.list()).filter(x => x.uniqueName === uniqueName)
                : [];

        const service = twilioClient.chat.services(serviceSID);
        const roles = await service.roles.list();
        const channelAdminRole = roles.find(x => x.friendlyName === "channel admin");
        const channelUserRole = roles.find(x => x.friendlyName === "channel user");

        assert(channelAdminRole);
        assert(channelUserRole);

        if (existingChannels.length > 0) {
            const newChannel = existingChannels[0];

            const members = (await newChannel.members().list()).map(x => x.identity);
            const invites = (await newChannel.invites().list()).map(x => x.identity);

            if (!members.includes(userProfile.id)) {
                await callWithRetry(() => newChannel.members().create({
                    identity: userProfile.id,
                    // TODO: If is admin, set as admin role
                    roleSid: isDM ? channelUserRole.sid : channelAdminRole.sid
                }));
            }

            await Promise.all(userProfilesToInvite.map(async profile => {
                if (!members.includes(profile.id) && !invites.includes(profile.id)) {
                    await callWithRetry(() => newChannel.invites().create({
                        identity: profile.id,
                        // TODO: If is admin, set as admin role
                        roleSid: channelUserRole.sid
                    }));
                }
            }));

            res.status(200);
            res.send({ channelSID: newChannel.sid });
            return;
        }
        else {
            const newChannel = await callWithRetry(() => service.channels.create({
                friendlyName,
                uniqueName,
                createdBy,
                type: mode,
                attributes: JSON.stringify(attributes)
            }));

            try {
                await ensureTwilioUsersExist(service, [...userProfilesToInvite, userProfile]);

                await callWithRetry(() => newChannel.members().create({
                    identity: userProfile.id,
                    // TODO: If is admin, set as admin role
                    roleSid: isDM ? channelUserRole.sid : channelAdminRole.sid
                }));

                await Promise.all(userProfilesToInvite.map(async profile => {
                    await callWithRetry(() => newChannel.invites().create({
                        identity: profile.id,
                        // TODO: If is admin, set as admin role
                        roleSid: channelUserRole.sid
                    }));
                }));

                console.log(`Created channel '${friendlyName}' (${newChannel.sid})`);

                res.status(200);
                res.send({ channelSID: newChannel.sid });
                return;
            }
            catch (e) {
                console.error("Could not create channel", e);

                await callWithRetry(() => newChannel.remove());

                res.status(500);
                res.send({ status: "Failed to add or invite members." });
                return;
            }
        }
    }
    catch (e) {
        next(e);
    }
}


// We have to control channel user roles by setting them at the time of
// invite / add so we need to control 'invite user'/'add member' through
// the backend.
// However, a user can only join private channels they have been invited to
// (so the role will be set), or join public channels (which will inherit their
// service-level role).

/**
 * Invite a user to join a chat.
 *
 * Request body:
 *  - identity: session token
 *  - conference: conference id
 *  - channel: Channel sid,
 *  - targetIdentities: Ids of the user profiles to invite
 */
export async function handleInviteToChat(req: Request, res: Response, next: NextFunction) {
    try {
        const requestContext = await handleRequestIntro(req, res, next);
        if (!requestContext) {
            return;
        }
        const { conf, config, userProfile } = requestContext;

        const _userProfileIdsToInvite = req.body.targetIdentities;
        const channelSID = req.body.channel;

        // Validate inputs
        if (!_userProfileIdsToInvite || !channelSID) {
            res.status(400);
            res.send({ status: "Missing request parameter(s)." });
            return;
        }

        if (typeof channelSID !== "string") {
            res.status(400);
            res.send({ status: "Channel should be a string." });
            return;
        }

        if (!(_userProfileIdsToInvite instanceof Array)) {
            res.status(400);
            res.send({ status: "Invited members should be an array." });
            return;
        }

        for (const inviteId of _userProfileIdsToInvite) {
            if (typeof inviteId !== "string") {
                res.status(400);
                res.send({ status: "Invited member ids should be strings." });
                return;
            }
        }

        const userProfileIdsToInvite = _userProfileIdsToInvite.filter(x => x !== userProfile.id) as string[];

        if (userProfileIdsToInvite.length === 0) {
            res.status(400);
            res.send({ status: "Invited members should be a non-empty array (that does not include yourself)." });
            return;
        }

        const _userProfilesToInvite = await Promise.all(
            userProfileIdsToInvite.map(async id => {
                return getUserProfileByID(id, conf);
            }));

        const usersValid = _userProfilesToInvite.every(x => !!x);
        if (!usersValid) {
            res.status(400);
            res.send({ status: "Users to invite invalid." });
            return;
        }
        const userProfilesToInvite = _userProfilesToInvite as Array<UserProfileT>;

        const accountSID = config.TWILIO_ACCOUNT_SID;
        const accountAuth = config.TWILIO_AUTH_TOKEN;
        const twilioClient = Twilio(accountSID, accountAuth);
        const serviceSID = config.TWILIO_CHAT_SERVICE_SID;

        const existingChannel
            = await twilioClient.chat
                .services(serviceSID)
                .channels(channelSID)
                .fetch();

        const service = twilioClient.chat.services(serviceSID);
        const roles = await service.roles.list();
        const channelAdminRole = roles.find(x => x.friendlyName === "channel admin");
        const channelUserRole = roles.find(x => x.friendlyName === "channel user");

        assert(channelAdminRole);
        assert(channelUserRole);

        if (existingChannel) {
            const attributes = JSON.parse(existingChannel.attributes);
            if (!attributes.isDM) {
                const members = (await existingChannel.members().list()).map(x => x.identity);
                const invites = (await existingChannel.invites().list()).map(x => x.identity);

                if (members.includes(userProfile.id)) {
                    await Promise.all(userProfilesToInvite.map(async profile => {
                        if (!members.includes(profile.id) && !invites.includes(profile.id)) {
                            await callWithRetry(() => existingChannel.invites().create({
                                identity: profile.id,
                                // TODO: If is admin, set as admin role
                                roleSid: channelUserRole.sid
                            }));
                        }
                    }));

                    res.status(200);
                    res.send({});
                    return;
                }
                else {
                    res.status(403);
                    res.send("Access denied.");
                }
            }
            else {
                res.status(400);
                res.send("Cannot invite more users to a DM chat.");
            }
        }
        else {
            res.status(500);
            res.send("Channel not found.");
        }
    } catch (err) {
        next(err);
    }
}

/**
 * Add a user as a member directly into a chat.
 *
 * Request body:
 *  - identity: session token
 *  - conference: conference id
 *  - channel: Channel sid,
 *  - targetIdentity: Id of user profile to add
 */
export async function handleAddToChat(req: Request, res: Response, next: NextFunction) {
    // TODO: Re-use code from create
}

/**
 * Request body:
 *  - identity: session token
 *  - conference: conference id
 *  - channel: channel sid
 *  - message: message sid
 *  - reaction: the reaction identifier string
 *
 * Response body:
 *  - ok: true
 *  or an error
 */
export async function handleAddReaction(req: Request, res: Response, next: NextFunction) {
    try {
        const requestContext = await handleRequestIntro(req, res, next);
        if (!requestContext) {
            return;
        }
        const { sessionObj, conf, config, userProfile } = requestContext;

        const channelSid = req.body.channel;
        if (!channelSid || typeof channelSid !== "string") {
            res.status(400);
            res.send({ status: "Invalid or missing channel sid" });
            return;
        }

        const messageSid = req.body.message;
        if (!messageSid || typeof messageSid !== "string") {
            res.status(400);
            res.send({ status: "Invalid or missing message sid" });
            return;
        }

        const reaction = req.body.reaction;
        if (!reaction || typeof reaction !== "string") {
            res.status(400);
            res.send({ status: "Invalid or missing reaction" });
            return;
        }

        const twilioClient = await getTwilioClient(conf.id, config);
        const chatService = twilioClient.chat.services(config.TWILIO_CHAT_SERVICE_SID);
        const channel = chatService.channels(channelSid);
        const members = await channel.members.list();
        if (!members.some(x => x.identity === userProfile.id)) {
            res.status(403);
            res.send({ status: "Invalid channel" });
            return;
        }
        const message = await channel.messages(messageSid).fetch();
        let attributes = JSON.parse(message.attributes);
        const reactions: { [k: string]: Array<string> } = attributes?.reactions ?? {};
        const reactionUsers = reactions[reaction] ?? [];
        if (!reactionUsers.includes(userProfile.id)) {
            reactionUsers.push(userProfile.id);
            reactions[reaction] = reactionUsers;
            attributes = { ...(attributes ?? {}), reactions };
            await message.update({
                attributes: JSON.stringify(attributes)
            });
        }

        res.set('Content-Type', 'application/json');
        res.send(JSON.stringify({
            ok: true
        }));
    } catch (err) {
        next(err);
    }
}

/**
 * Request body:
 *  - identity: session token
 *  - conference: conference id
 *  - channel: channel sid
 *  - message: message sid
 *  - reaction: the reaction identifier string
 *
 * Response body:
 *  - ok: true
 *  or an error
 */
export async function handleRemoveReaction(req: Request, res: Response, next: NextFunction) {
    try {
        const requestContext = await handleRequestIntro(req, res, next);
        if (!requestContext) {
            return;
        }
        const { sessionObj, conf, config, userProfile } = requestContext;

        const channelSid = req.body.channel;
        if (!channelSid || typeof channelSid !== "string") {
            res.status(400);
            res.send({ status: "Invalid or missing channel sid" });
            return;
        }

        const messageSid = req.body.message;
        if (!messageSid || typeof messageSid !== "string") {
            res.status(400);
            res.send({ status: "Invalid or missing message sid" });
            return;
        }

        const reaction = req.body.reaction;
        if (!reaction || typeof reaction !== "string") {
            res.status(400);
            res.send({ status: "Invalid or missing reaction" });
            return;
        }

        const twilioClient = await getTwilioClient(conf.id, config);
        const chatService = twilioClient.chat.services(config.TWILIO_CHAT_SERVICE_SID);
        const channel = chatService.channels(channelSid);
        const members = await channel.members.list();
        if (!members.some(x => x.identity === userProfile.id)) {
            res.status(403);
            res.send({ status: "Invalid channel" });
            return;
        }
        const message = await channel.messages(messageSid).fetch();
        let attributes = JSON.parse(message.attributes);
        const reactions: { [k: string]: Array<string> } = attributes?.reactions ?? {};
        const reactionUsers = reactions[reaction] ?? [];
        if (reactionUsers.includes(userProfile.id)) {
            reactions[reaction] = reactionUsers.filter(x => x !== userProfile.id);
            if (reactions[reaction].length === 0) {
                delete reactions[reaction];
            }
            attributes = { ...(attributes ?? {}), reactions };
            await message.update({
                attributes: JSON.stringify(attributes)
            });
        }

        res.set('Content-Type', 'application/json');
        res.send(JSON.stringify({
            ok: true
        }));
    } catch (err) {
        next(err);
    }
}

// When adding a reaction, the attributes have a size limit
// Message attributes have a 4KiB limit (https://www.twilio.com/docs/chat/chat-limits)
// A Parse Server profile unique ID is typically 10 characters = 10 bytes, so we
// can store about 400 reactions to a single message.

// TODO: "Allowed to send message" query

// TODO: Prevent private channels from growing too large (i.e. not more than 1000 users)
//       otherwise they spill over into being mirrored and we don't support private mirrored
//       chats at the moment.
