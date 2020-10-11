import Parse from "parse/node";
import { Request, Response, NextFunction } from 'express';

import { getSession, getConference, getUserProfile } from "./ParseHelpers";

import { ClowdrConfig, getConfig } from "./Config";
import { ConferenceT, UserProfileT } from './SchemaTypes';

import { backOff } from 'exponential-backoff';

export async function callWithRetry<T>(f: () => Promise<T>): Promise<T> {
    const response = await backOff(f,
        {
            startingDelay: 500,
            retry: (err, attemptNum) => {
                console.error(err);
                if (err && err.code === 20429)
                    return true;
                console.log("Unexpected error:")
                console.error(err);
                return false;
            }
        });
    return response;
}

export async function handleRequestIntro(req: Request, res: Response, next: NextFunction):
    Promise<{
        sessionToken: string,
        sessionObj: Parse.Session,
        conf: ConferenceT,
        config: ClowdrConfig,
        userProfile: UserProfileT
    } | undefined> {
    let ok = true;
    const sessionToken = req.body.identity;
    const sessionObj = await getSession(sessionToken);
    if (!sessionObj) {
        ok = false;
        res.status(401);
        res.send({ status: "Invalid session token." })
        return undefined;
    }
    if (!req.body.conference) {
        ok = false;
        res.status(400);
        res.send({ status: "Invalid conference." })
        return undefined;
    }
    let conf: ConferenceT;
    let config: ClowdrConfig;
    try {
        conf = await getConference(req.body.conference);
        config = await getConfig(conf.id);
        const userProfile = await getUserProfile(sessionObj.get("user"), conf);
        if (!userProfile || userProfile.get("isBanned")) {
            ok = false;
            res.status(403);
            res.send({ status: "Permission denied." })
            return undefined;
        }

        return {
            sessionToken, sessionObj, conf, config, userProfile
        };
    }
    catch (e) {
        ok = false;
        res.status(400);
        res.send({ status: "Invalid conference." })
        return undefined;
    }
}
