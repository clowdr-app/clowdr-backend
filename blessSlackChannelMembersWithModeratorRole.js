require('dotenv').config()
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
    return r;
}

async function findUserBySlackIDAndConference(slackUID, conf) {
    let profileQ = new Parse.Query(UserProfile);
    profileQ.equalTo("slackID", slackUID);
    profileQ.equalTo("conference", conf);
    let u = await profileQ.first({useMasterKey: true});
    if(!u){
        let user_info = await conf.config.slackClient.users.info({user: slackUID});
        if(user_info.user.name =='clowdr')
            return;
        console.log("Missing: " + slackUID)
        console.log(user_info);
    }
    return u.get("user");
}

async function blessByChannelMembers(confName, channelName){
    let conf = await getConferenceByName(confName);
    let allChannels = await conf.config.slackClient.conversations.list({types: "private_channel,public_channel"});
    let channel = allChannels.channels.find((c)=> c.name == channelName);
    if(!channel){
        console.log("Unable to find channel  "+ channelName + ". Are you sure that clowdr is a member of the channel?")
    }else{
        let users = await conf.config.slackClient.conversations.members({channel: channel.id, limit:200});
        let parseUsers = [];
        for(let slackUID of users.members){
            parseUsers.push(findUserBySlackIDAndConference(slackUID, conf));
        }
        let resolvedUsers = await Promise.all(parseUsers);
        resolvedUsers = resolvedUsers.filter((u)=>u);
        let roleQ = new Parse.Query(Parse.Role);
        roleQ.equalTo("name", conf.id+"-moderator");
        let role = await roleQ.first({useMasterKey: true});
        role.getUsers().add(resolvedUsers);
        await role.save({}, {useMasterKey: true});
    }


}
if(process.argv.length != 4){
    console.log("Usage: node blessSlackChannelMembersWithModeratorRole <confernce name> <channelName>");
}
else{
    blessByChannelMembers(process.argv[2], process.argv[3]).then(()=>{
        console.log("Done");
    })
}