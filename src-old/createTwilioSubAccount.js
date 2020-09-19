"use strict";
require('dotenv').config()

const Parse = require("parse/node");
var jwt = require('jsonwebtoken');
const crypto = require('crypto');

const Twilio = require("twilio");


Parse.initialize(process.env.REACT_APP_PARSE_APP_ID, process.env.REACT_APP_PARSE_JS_KEY, process.env.PARSE_MASTER_KEY);
Parse.serverURL = process.env.REACT_APP_PARSE_DATABASE_URL;
let InstanceConfig = Parse.Object.extend("InstanceConfiguration");

async function addOrReplaceConfig(installTo, key, value) {
    if (!installTo.config) {
        installTo.config = {};
    }
    let existingTokenQ = new Parse.Query(ClowdrInstance);
    existingTokenQ.equalTo("key", key);
    existingTokenQ.equalTo("instance", installTo);
    let tokenConfig = await existingTokenQ.first({}, { useMasterKey: true });
    if (!tokenConfig) {
        //Add the token
        tokenConfig = new InstanceConfig();
        tokenConfig.set("key", key);
        tokenConfig.set("instance", installTo);
    }
    installTo.config[key] = value;
    tokenConfig.set("value", value);
    let adminRole = installTo.id + "-admin";

    let acl = new Parse.ACL();
    acl.setPublicReadAccess(false);
    acl.setPublicWriteAccess(false);
    acl.setRoleReadAccess(adminRole, true);
    acl.setRoleWriteAccess(adminRole, true);
    tokenConfig.setACL(acl, { useMasterKey: true });

    return tokenConfig.save({}, { useMasterKey: true });
}

const masterTwilioClient = Twilio(process.env.TWILIO_MASTER_SID ? process.env.TWILIO_MASTER_SID : "AC123",
    process.env.TWILIO_MASTER_AUTH_TOKEN ? process.env.TWILIO_MASTER_AUTH_TOKEN : "123");


async function installTwilio(installTo, name) {
    let account = await masterTwilioClient.api.accounts.create({ friendlyName: installTo.id + ": " + name });
    let newAuthToken = account.authToken;
    let newSID = account.sid;

    let tempClient = Twilio(newSID, newAuthToken);
    let new_key = await tempClient.newKeys.create();
    await addOrReplaceConfig(installTo, "TWILIO_API_KEY", new_key.sid);
    await addOrReplaceConfig(installTo, "TWILIO_API_SECRET", new_key.secret);
    await addOrReplaceConfig(installTo, "TWILIO_ACCOUNT_SID", newSID);
    await addOrReplaceConfig(installTo, "TWILIO_AUTH_TOKEN", newAuthToken);
}
let ClowdrInstance = Parse.Object.extend("ClowdrInstance");
let inst = new ClowdrInstance();
inst.id = 'ADWt6iuJ6f';
installTwilio(inst, "ASE2020");
