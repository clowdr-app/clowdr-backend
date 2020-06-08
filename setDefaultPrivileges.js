require('dotenv').config()

const Parse = require("parse/node");
Parse.initialize(process.env.REACT_APP_PARSE_APP_ID, process.env.REACT_APP_PARSE_JS_KEY, process.env.PARSE_MASTER_KEY);
Parse.serverURL = process.env.REACT_APP_PARSE_DATABASE_URL;


var privilegeRoles = {
    "createVideoRoom": null,
    "chat": null,
    "access-from-slack": null,
    "createVideoRoom-persistent": null,
    "createVideoRoom-group": null,
    "createVideoRoom-smallgroup": null,
    "createVideoRoom-peer-to-peer": null,
    'createVideoRoom-private': null
};
let PrivilegedAction = Parse.Object.extend("PrivilegedAction");
let InstancePermission = Parse.Object.extend("InstancePermission");

var adminRole;

async function getParseAdminRole() {
    if (adminRole)
        return adminRole;
    let roleQ = new Parse.Query(Parse.Role);
    roleQ.equalTo("name", "ClowdrSysAdmin");
    adminRole = await roleQ.first({useMasterKey: true});
    return adminRole;
}

async function createPrivileges() {
    return Promise.all(Object.keys(privilegeRoles).map(async (action) => {
            let actionsQ = new Parse.Query(PrivilegedAction);
            actionsQ.equalTo("action", action)
            actionsQ.include("role");
            let res = await actionsQ.first({useMasterKey: true});
            if (!res) {
                let pa = new PrivilegedAction();
                pa.set("action", action);
                // let roleACL = new Parse.ACL();
                // roleACL.setPublicReadAccess(true);
                // roleACL.setRoleWriteAccess(await getParseAdminRole(), true);
                // let prole = new Parse.Role("action-" + action, roleACL);
                // await prole.save({}, {useMasterKey: true});
                // pa.set("role", prole);
                // let actionACL = new Parse.ACL();
                // actionACL.setPublicReadAccess(false);
                // actionACL.setRoleReadAccess(prole, true);
                // pa.setACL(actionACL);
                res = await pa.save({}, {useMasterKey: true});
            }
            privilegeRoles[action] = res;
        }
    ));
}

createPrivileges().then(async (res) => {
    let confsQ = new Parse.Query("ClowdrInstance");
    let confs = await confsQ.find({useMasterKey: true});

    Promise.all(confs.map(async(conf)=>{
        let promises = [];
        for(let action of Object.values(privilegeRoles)){
            let permissionQ = new Parse.Query(InstancePermission);
            permissionQ.equalTo("conference", conf);
            permissionQ.equalTo("action", action);
            let priv = await permissionQ.first({useMasterKey: true});
            if(!priv){
                console.log("Creating")
                priv = new InstancePermission();
                priv.set("conference",conf);
                priv.set("action",action);
                let acl =new Parse.ACL();
                acl.setPublicReadAccess(false)
                acl.setRoleReadAccess(conf.id+"-conference",true);
                priv.setACL(acl);
                promises.push(priv.save({},{useMasterKey: true}));
            }
        }
        return promises;
    }));
    console.log("DOne")
})