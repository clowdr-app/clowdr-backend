require('dotenv').config()
const Twilio = require("twilio");

const Parse = require("parse/node");
Parse.initialize(process.env.REACT_APP_PARSE_APP_ID, process.env.REACT_APP_PARSE_JS_KEY, process.env.PARSE_MASTER_KEY);
Parse.serverURL = process.env.REACT_APP_PARSE_DATABASE_URL;
const {WebClient} = require('@slack/web-api');
let SlackHomeBlocks = Parse.Object.extend("SlackHomeBlocks");
let ClowdrInstance = Parse.Object.extend("ClowdrInstance");
let ClowdrInstanceAccess = Parse.Object.extend("ClowdrInstanceAccess");

let InstanceConfig = Parse.Object.extend("InstanceConfiguration");
let BreakoutRoom = Parse.Object.extend("BreakoutRoom");
let PrivilegedAction = Parse.Object.extend("PrivilegedAction");
var InstancePermission = Parse.Object.extend("InstancePermission");
let LiveActivity = Parse.Object.extend("LiveActivity");
let Channel = Parse.Object.extend("Channel");
let UserProfile = Parse.Object.extend("UserProfile");
let SocialSpace = Parse.Object.extend("SocialSpace");

async function getConfig(conf) {
    let q = new Parse.Query(InstanceConfig)
    q.equalTo("instance", conf);
    let res = await q.find({useMasterKey: true});
    let config = {};
    for (let obj of res) {
        config[obj.get("key")] = obj.get("value");
    }
    if (!config.FRONTEND_URL) {
        config.FRONTEND_URL = "https://staging.clowdr.org"
    }
    if (!config.TWILIO_CALLBACK_URL) {
        config.TWILIO_CALLBACK_URL = "https://clowdr.herokuapp.com/twilio/event"
        // config.TWILIO_CALLBACK_URL = "https://clowdr-dev.ngrok.io/twilio/event" //TODO
    }
    if (!config.TWILIO_ROOM_TYPE) {
        config.TWILIO_ROOM_TYPE = "group-small";
    }
    if (!config.AUTO_CREATE_USER) {
        config.AUTO_CREATE_USER = true;
    }
    // config.TWILIO_CALLBACK_URL = "https://clowdr-dev.ngrok.io/twilio/event";
    config.slackClient = new WebClient(config.SLACK_BOT_TOKEN);

    // console.log(JSON.stringify(config,null,2))
    return config;
}

async function getConferenceByName(confName){
    let q = new Parse.Query(ClowdrInstance);
    let r = undefined;
    try {
        q.equalTo("conferenceName", confName);
        r = await q.first();
    } catch (err) {
        console.log(err);
    }
    // } catch (err) {
    if (!r) {
        console.log("Unable to find workspace in ClowdrDB: " + confName);
    }
    r.config = await getConfig(r);
    r.twilio = Twilio(r.config.TWILIO_ACCOUNT_SID, r.config.TWILIO_AUTH_TOKEN);

    return r;
}


var globalSocialSpaces =[
    "Lobby",
    "Posters",
    "Breakout Rooms"
];
async function createSocialSpaces(confName){
    let conf = await getConferenceByName(confName);
    for(let spaceName of globalSocialSpaces){
        let spaceQ = new Parse.Query(SocialSpace);
        spaceQ.equalTo("conference",conf);
        spaceQ.equalTo("name", spaceName);
        spaceQ.equalTo("isGlobal", true);
        let space = await spaceQ.first({useMasterKey: true});
        if(!space){
            space= new SocialSpace();
            space.set("conference", conf);
            space.set("name",spaceName);
            space.set("isGlobal", true);
            let acl = new Parse.ACL();
            acl.setPublicWriteAccess(false);
            acl.setPublicReadAccess(false);
            acl.setRoleReadAccess(conf.id+"-conference", true);
            acl.setRoleWriteAccess(conf.id+"-moderator", true);
            space.setACL(acl);
            space = await space.save({}, {useMasterKey: true});
        }
        if(!space.get("chatChannel")){
            let chat = conf.twilio.chat.services(conf.config.TWILIO_CHAT_SERVICE_SID);
            let twilioChatRoom = await chat.channels.create({
                friendlyName: spaceName,
                type: "public",
                attributes: {
                    type: "SocialSpace",
                    isGlobal: true,
                    id: space.id
                }
            });
            space.set("chatChannel", twilioChatRoom.sid);

            await space.save({}, {useMasterKey: true})
        }
    }

}
async function getOrCreateRole(confID, roleSuffix){
    let conferencePrivQ = new Parse.Query(Parse.Role);
    conferencePrivQ.equalTo("name",confID+"-"+roleSuffix);
    let confPriv = await conferencePrivQ.first({useMasterKey: true});
    if(!confPriv){
        let roleACL = new Parse.ACL();
        roleACL.setPublicReadAccess(true);
        confPriv = new Parse.Role(confID+"-"+roleSuffix, roleACL);
        await confPriv.save({},{useMasterKey: true});
    }
    return confPriv;

}
async function createDefaultRoles(conferenceName){
    let conf = await getConferenceByName(conferenceName);
    let confRole = await getOrCreateRole(conf.id,"conference")
    let modRole = await getOrCreateRole(conf.id,"moderator")
    let managerRole = await getOrCreateRole(conf.id,"manager")
    let adminRole = await getOrCreateRole(conf.id,"admin")

}
// if(process.argv.length != 4){
//     console.log("Usage: node blessSlackChannelMembersWithModeratorRole <confernce name> <channelName>");
// }
// else{
//     createSocialSpace(process.argv[2], process.argv[3]).then(()=>{
//         console.log("Done");
//     })
// }

let confQ = new Parse.Query(ClowdrInstance);
confQ.find({useMasterKey: true}).then( async(confs)=>{
    for (let conf of confs){
        // await createDefaultRoles(conf.get("conferenceName"));
        // await createSocialSpaces(conf.get("conferenceName"));
    }
})