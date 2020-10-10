import { Request, Response, NextFunction } from 'express';

import { generateChatToken } from "./tokens";

import { handleRequestIntro } from './RequestHelpers';
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

// TODO: Rewrite these to work based on TextChat ACLs?

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
