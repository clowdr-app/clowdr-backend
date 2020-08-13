const crypto = require('crypto');

const fs = require("fs");
const Parse = require("parse/node");
let ClowdrInstance = Parse.Object.extend("ClowdrInstance");
require('dotenv').config()

let ZoomRoom = Parse.Object.extend("ZoomRoom");
let ZoomHostAccount = Parse.Object.extend("ZoomHostAccount");

let InstanceConfig = Parse.Object.extend("InstanceConfiguration");
const Twilio = require("twilio");
const axios = require('axios');
var jwt = require('jsonwebtoken');

Parse.initialize(process.env.REACT_APP_PARSE_APP_ID, process.env.REACT_APP_PARSE_JS_KEY, process.env.PARSE_MASTER_KEY);
Parse.serverURL = 'https://parseapi.back4app.com/'

async function getConfig(conference){
    let configQ = new Parse.Query(InstanceConfig);
    configQ.equalTo("instance", conference);
    // configQ.cache(60);
    let res = await configQ.find({useMasterKey: true});
    let config = {};
    for (let obj of res) {
        config[obj.get("key")] = obj.get("value");
    }
    config.twilio = Twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
    config.twilioChat = config.twilio.chat.services(config.TWILIO_CHAT_SERVICE_SID);

    if (!config.TWILIO_CALLBACK_URL) {
        config.TWILIO_CALLBACK_URL = "https://clowdr.herokuapp.com/twilio/event"
    }
    if(!config.TWILIO_CHAT_CHANNEL_MANAGER_ROLE){
        let role = await config.twilioChat.roles.create({
            friendlyName :'clowdrAttendeeManagedChatParticipant',
            type: 'channel',
            permission: ['addMember','deleteOwnMessage','editOwnMessage','editOwnMessageAttributes','inviteMember','leaveChannel','sendMessage','sendMediaMessage',
                'editChannelName','editChannelAttributes']
        })
        let newConf = new InstanceConfig();
        newConf.set("instance", conference);
        newConf.set("key","TWILIO_CHAT_CHANNEL_MANAGER_ROLE");
        newConf.set("value", role.sid);
        await newConf.save({},{useMasterKey: true});
        config.TWILIO_CHAT_CHANNEL_MANAGER_ROLE = role.sid;
    }
    if(!config.TWILIO_CHAT_CHANNEL_OBSERVER_ROLE){
        let role = await config.twilioChat.roles.create({
            friendlyName :'clowdrChatObserver',
            type: 'channel',
            permission: ['deleteOwnMessage']
        })
        let newConf = new InstanceConfig();
        newConf.set("instance", conference);
        newConf.set("key","TWILIO_CHAT_CHANNEL_OBSERVER_ROLE");
        newConf.set("value", role.sid);
        await newConf.save({},{useMasterKey: true});
        config.TWILIO_CHAT_CHANNEL_OBSERVER_ROLE = role.sid;
    }
    if(!config.TWILIO_ANNOUNCEMENTS_CHANNEL){
        let attributes = {
            category: "announcements-global",
        }
        let chatRoom = await config.twilioChat.channels.create(
            {friendlyName: "Announcements", type: "private",
                attributes: JSON.stringify(attributes)});
        let newConf = new InstanceConfig();
        newConf.set("instance", conference);
        newConf.set("key","TWILIO_ANNOUNCEMENTS_CHANNEL");
        newConf.set("value", chatRoom.sid);
        await newConf.save({},{useMasterKey: true});
        config.TWILIO_ANNOUNCEMENTS_CHANNEL = chatRoom.sid;
    }
    return config;
}
function generateRandomString(length) {
    return new Promise((resolve, reject) => {
        crypto.randomBytes(length,
            function (err, buffer) {
                if (err) {
                    return reject(err);
                }
                var token = buffer.toString('hex');
                return resolve(token);
            });
    })
}

let confQ = new Parse.Query(ClowdrInstance);
confQ.equalTo("conferenceName", "ICFP 2020")
confQ.find({useMasterKey: true}).then(async (confs) => {
    for (let conf of confs) {
        let config = await getConfig(conf);
        const payload = {
            iss: config.ZOOM_API_KEY,
            exp: ((new Date()).getTime() + 5000)
        };
        const token = jwt.sign(payload, config.ZOOM_API_SECRET);
        let pwd = await generateRandomString(30);
        console.log(pwd);
        for(let i = 1; i < 9; i++){
            let email = 'zoom+icfp' + i + "@clowdr.org";
            try {
                let res = await axios({
                    method: 'post',
                    url: 'https://api.zoom.us/v2/users/',
                    data: {
                        action: 'create',
                        user_info: {
                            email: email,
                            type: 2,
                            first_name: "zoomer",
                            last_name: "icfp" + i
                        }
                    },
                    headers: {
                        'Authorization': 'Bearer ' + token,
                        'User-Agent': 'Zoom-api-Jwt-Request',
                        'content-type': 'application/json'
                    }
                });
                console.log(res);
            }catch(err){
                console.log(err);
                console.log(config.ZOOM_API_KEY);
                console.log(config.ZOOM_API_SECRET);
                return;
            }
            let account = new ZoomHostAccount();
            let acl = new Parse.ACL();
            acl.setPublicWriteAccess(false);
            acl.setPublicReadAccess(false);
            acl.setRoleReadAccess(conf.id+"-admin", true);
            acl.setRoleReadAccess("ClowdrSysAdmin", true);
            account.setACL(acl);
            account.set("conference", conf);
            account.set("email", email);
            account.set("password", pwd);
            await account.save({},{useMasterKey: true})

        }
    }
});