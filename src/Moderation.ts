import Parse from "parse/node";

// async function getModeratorChannel(conf) {
//     return conf.moderatorChannel;
// }
// async function sendModeratorMessage(req, res) {
//     let identity = req.body.identity;
//     const roomID = req.body.roomID;
//     const conference = req.body.conference;
//     const participants = req.body.participants;
//     let conf = await getConference(conference);
//     let userQ = new Parse.Query(Parse.Session);
//     userQ.equalTo("sessionToken", identity);
//     let parseSession = await userQ.first({ useMasterKey: true });
//     let parseUser = parseSession.get("user");
//     let profileQ = new Parse.Query(UserProfile);
//     profileQ.equalTo("user", parseUser);
//     profileQ.equalTo("conference", conf);
//     let profile = await profileQ.first({ useMasterKey: true });
//     //Check for roles...
//     let roomQ = new Parse.Query("BreakoutRoom");
//     let room = await roomQ.get(roomID, { sessionToken: identity });
//     if (!room) {
//         return res.send({ status: 'error', message: "No such room" });
//     }
//     let unfilledUsers = [];
//     for (let id of participants) {
//         unfilledUsers.push(UserProfile.createWithoutData(id));
//     }
//     let users = await Parse.Object.fetchAll(unfilledUsers, { useMasterKey: true });
//     let usersString = "";
//     for (let user of users) {
//         usersString += user.get("displayName") + ", ";
//     }
//     if (usersString.length > 0) {
//         usersString = usersString.substring(0, usersString.length - 2);
//     }

//     res.send({ status: "OK" });
// }
