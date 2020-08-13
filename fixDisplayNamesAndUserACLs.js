
require('dotenv').config()

const Parse = require("parse/node");
Parse.initialize(process.env.REACT_APP_PARSE_APP_ID, process.env.REACT_APP_PARSE_JS_KEY, process.env.PARSE_MASTER_KEY);
Parse.serverURL = process.env.REACT_APP_PARSE_DATABASE_URL;


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


var privilegeRoles = {
    "createVideoRoom": null,
    "chat": null,
    "access-from-slack": null,
    "createVideoRoom-persistent": null,
    "createVideoRoom-group": null,
    "createVideoRoom-smallgroup": null,
    "createVideoRoom-peer-to-peer": null,
    'createVideoRoom-private': null,
    "moderator": null,
    'announcement-global': null
};

async function createPrivileges() {
    return Promise.all(Object.keys(privilegeRoles).map(async (action) => {
            let actionsQ = new Parse.Query(PrivilegedAction);
            actionsQ.equalTo("action", action)
            actionsQ.include("role");
            let res = await actionsQ.first({useMasterKey: true});
            if (!res) {
                let pa = new PrivilegedAction();
                pa.set("action", action);
                res = await pa.save({}, {useMasterKey: true});
            }
            privilegeRoles[action] = res;
        }
    ));
}
async function runBackend() {
    let promises = [];
    await createPrivileges();
    let query = new Parse.Query(ClowdrInstance);
    query.find({useMasterKey: true}).then((instances) => {
        instances.forEach(
            async (inst) => {
                try {
                    if (inst.get("slackWorkspace") && inst.id =='pvckfSmmTp')
                        promises.push(getConference(inst.get("slackWorkspace")).then((conf) => {
                            console.log("Finished " + conf.get("conferenceName"))
                        }).catch(err => {
                            console.log("Unable to load data for  " + inst.get("conferenceName"))
                            console.log(err);
                        }));
                } catch (err) {
                    console.log(err);
                }
            }
        )
    }).catch((err) => {
        console.log(err);
    });


    Promise.all(promises).then(() => {
        app.listen(process.env.PORT || 3001, () =>
            console.log('Express server is running on localhost:3001')
        );
    });
}

runBackend();
