import Parse from "parse";
import { getConfig } from "./Config";
import { initChatRooms } from "./InitConference";
import { Conference, ConferenceT } from "./SchemaTypes";

export async function getSession(token: string): Promise<Parse.Session | null> {
    let query = new Parse.Query(Parse.Session);
    query.include("user");
    query.equalTo("sessionToken", token);
    let session = await query.first({ useMasterKey: true });
    if (session) {
        return session;
    }
    return null;
}

const conferenceCache = new Map<string, ConferenceT>();
export async function getConference(id: string): Promise<ConferenceT> {
    let result = conferenceCache.get(id);
    if (result) {
        return result;
    }

    let q = new Parse.Query(Conference);
    result = await q.get(id, { useMasterKey: true });
    conferenceCache.set(id, result);

    // Initialise config cache for this conference
    await getConfig(result.id);
    // Initialise the conference if it has not already been
    await initChatRooms(result);

    return result;
}

// async function getUserProfile(uid, conf) {
//     let cacheKey = uid + "-" + conf.id;
//     console.log(cacheKey)
//     if (!uidToProfileCache[cacheKey]) {
//         let uq = new Parse.Query(UserProfile);
//         let fauxUser = new Parse.User();
//         fauxUser.id = uid;
//         uq.equalTo("user", fauxUser);
//         uq.equalTo("conference", conf);
//         let res = await uq.first({ useMasterKey: true });
//         console.log(res);
//         uidToProfileCache[cacheKey] = res;
//     }
//     return uidToProfileCache[cacheKey];
// }


// var allUsersPromise;
// var emailsToParseUser;
// var parseUIDToProfiles;
// function getAllUsers() {
//     if (allUsersPromise)
//         return allUsersPromise;
//     if (emailsToParseUser) {
//         return new Promise((resolve) => resolve(emailsToParseUser));
//     }
//     let usersPromise = new Promise(async (resolve, reject) => {
//         emailsToParseUser = {};
//         try {
//             let parseUserQ = new Parse.Query(Parse.User);
//             parseUserQ.limit(1000);
//             parseUserQ.withCount();
//             parseUserQ.include("profiles");
//             let nRetrieved = 0;
//             let { count, results } = await parseUserQ.find({ useMasterKey: true });
//             nRetrieved = results.length;
//             // console.log(count);
//             // console.log(results);
//             results.map((u) => {
//                 emailsToParseUser[u.get("username")] = u;
//             });
//             while (nRetrieved < count) {
//                 // totalCount = count;
//                 let parseUserQ = new Parse.Query(Parse.User);
//                 parseUserQ.limit(1000);
//                 parseUserQ.skip(nRetrieved);
//                 let results = await parseUserQ.find({ useMasterKey: true });
//                 // results = dat.results;
//                 nRetrieved += results.length;
//                 if (results)
//                     results.map((u) => {
//                         emailsToParseUser[u.get("username")] = u;
//                     });
//             }
//             allUsersPromise = null;
//             resolve(emailsToParseUser);
//         } catch (err) {
//             console.log("In get all users ")
//             console.error(err);
//             reject(err);
//         }
//     })
//     let profilesPromise = new Promise(async (resolve, reject) => {
//         parseUIDToProfiles = {};
//         try {
//             let parseUserQ = new Parse.Query(UserProfile);
//             parseUserQ.limit(1000);
//             parseUserQ.withCount();
//             let nRetrieved = 0;
//             let { count, results } = await parseUserQ.find({ useMasterKey: true });
//             nRetrieved = results.length;
//             // console.log(count);
//             // console.log(results);
//             results.map((u) => {
//                 if (!parseUIDToProfiles[u.get("user").id]) {
//                     parseUIDToProfiles[u.get("user").id] = {};
//                 }
//                 parseUIDToProfiles[u.get("user").id][u.get("conference").id] = u;
//             });
//             while (nRetrieved < count) {
//                 // totalCount = count;
//                 let parseUserQ = new Parse.Query(UserProfile);
//                 parseUserQ.limit(1000);
//                 parseUserQ.skip(nRetrieved);
//                 let results = await parseUserQ.find({ useMasterKey: true });
//                 // results = dat.results;
//                 nRetrieved += results.length;
//                 if (results)
//                     results.map((u) => {
//                         if (!parseUIDToProfiles[u.get("user").id]) {
//                             parseUIDToProfiles[u.get("user").id] = {};
//                         }
//                         parseUIDToProfiles[u.get("user").id][u.get("conference").id] = u;
//                     });
//             }
//             allUsersPromise = null;
//             resolve(parseUIDToProfiles);
//         } catch (err) {
//             console.log("In get all user profiles ")
//             console.error(err);
//             reject(err);
//         }
//     })
//     allUsersPromise = Promise.all([usersPromise, profilesPromise]);
//     return allUsersPromise;
// }
