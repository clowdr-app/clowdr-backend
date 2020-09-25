import { Request, Response, NextFunction } from 'express';

import { ChatGrant, generateToken } from "./tokens";

import { callWithRetry, handleRequestIntro } from './RequestHelpers';
import { getUserProfileByID } from './ParseHelpers';

import Twilio from "twilio";
import { UserProfileT } from './SchemaTypes';

import uuid from "uuid";
import assert from "assert";
import { ServiceContext } from 'twilio/lib/rest/chat/v2/service';

export async function handleGenerateFreshToken(req: Request, res: Response, next: NextFunction) {
    try {
        const requestContext = await handleRequestIntro(req, res, next);
        if (!requestContext) {
            return;
        }
        const [sessionObj, conf, config, userProfile] = requestContext;

        console.log(`${new Date().toUTCString()} [/chat/token]: User: '${userProfile.get("displayName")}' (${userProfile.id}), Conference: '${conf.get("name")}' (${conf.id})`);

        const identity = userProfile.id;
        const sessionID = sessionObj.id;
        const now = Date.now();
        const chatGrant = new ChatGrant({
            serviceSid: config.TWILIO_CHAT_SERVICE_SID,
            endpointId: `${identity}:browser:${sessionID}:${now}`
        });

        // TODO: Put Twilio token TTL (time-to-live) into configuration in database
        const expiryDistanceSeconds = 3600 * 3;
        const accessToken = generateToken(config, identity, expiryDistanceSeconds);
        accessToken.addGrant(chatGrant);
        res.set('Content-Type', 'application/json');
        res.send(JSON.stringify({
            token: accessToken.toJwt(),
            identity: identity,
            expiry: new Date().getTime() + (expiryDistanceSeconds * 1000)
        }));
    } catch (err) {
        next(err);
    }
}

async function ensureTwilioUsersExist(service: ServiceContext, profiles: Array<UserProfileT>) {
    let existingUserProfileIds = (await service.users.list()).map(x => x.identity);
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

/**
 * Request body:
 * 
 * identity: session token
 * conference: conference id
 * invite: user profile ids to invite
 * mode: 'public' or 'private'
 * title: friendly name
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
        const [sessionObj, conf, config, userProfile] = requestContext;

        const userProfileIdsToInvite = req.body.invite;
        const mode = req.body.mode;
        let title = req.body.title;

        // Validate inputs
        if (!userProfileIdsToInvite || !mode || !title) {
            res.status(400);
            res.send({ status: "Missing request parameter(s)." });
            return;
        }

        if (!(userProfileIdsToInvite instanceof Array) || userProfileIdsToInvite.length === 0) {
            res.status(400);
            res.send({ status: "Invited members should be a non-empty array." });
            return;
        }

        for (const inviteId of userProfileIdsToInvite) {
            if (typeof inviteId !== "string") {
                res.status(400);
                res.send({ status: "Invited member ids should be strings." });
                return;
            }
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
        const friendlyName = title;
        // Twilio max-length 64 chars
        const uniqueName
            = (isDM
                ? (userProfile.id.localeCompare(userProfilesToInvite[0].id) === -1
                    ? userProfile.id + "-" + userProfilesToInvite[0].id
                    : userProfilesToInvite[0].id + "-" + userProfile.id)
                : (userProfile.id + "-" + uuid.v4()))
                .substr(0, 64);
        const createdBy = isDM ? "system" : userProfile.id;
        const attributes = {
            isDM: isDM
        };
        if (isDM) {
            attributes["member1"] = userProfile.id;
            attributes["member2"] = userProfilesToInvite[0].id;
        }

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
        if (existingChannels.length > 0) {
            res.status(200);
            res.send({ channelSID: existingChannels[0].sid });
            return;
        }
        else {
            const service = twilioClient.chat.services(serviceSID);
            const roles = await service.roles.list();
            const channelAdminRole = roles.find(x => x.friendlyName === "channel admin");
            const channelUserRole = roles.find(x => x.friendlyName === "channel user");

            assert(channelAdminRole);
            assert(channelUserRole);

            const newChannel = await callWithRetry(() => service.channels.create({
                friendlyName: friendlyName,
                uniqueName: uniqueName,
                createdBy: createdBy,
                type: mode,
                attributes: JSON.stringify(attributes)
            }));

            try {
                await ensureTwilioUsersExist(service, [...userProfilesToInvite, userProfile]);

                await callWithRetry(() => newChannel.members().create({
                    identity: userProfile.id,
                    roleSid: isDM ? channelUserRole.sid : channelAdminRole.sid
                }));

                await Promise.all(userProfilesToInvite.map(async profile => {
                    await callWithRetry(() => newChannel.invites().create({
                        identity: profile.id,
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

// TODO: We have to control channel user roles by setting them at the time of
//       invite / add so we need to control 'invite user'/'add member' through
//       the backend
