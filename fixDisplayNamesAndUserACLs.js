
require('dotenv').config()

const Parse = require("parse/node");
Parse.initialize(process.env.REACT_APP_PARSE_APP_ID, process.env.REACT_APP_PARSE_JS_KEY, process.env.PARSE_MASTER_KEY);
Parse.serverURL = process.env.REACT_APP_PARSE_DATABASE_URL;


let ClowdrInstance = Parse.Object.extend("ClowdrInstance");
let PrivilegedAction = Parse.Object.extend("PrivilegedAction");

var privilegeRoles = {
    "createVideoRoom": null,
    "chat": null,
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
        let res = await actionsQ.first({ useMasterKey: true });
        if (!res) {
            let pa = new PrivilegedAction();
            pa.set("action", action);
            res = await pa.save({}, { useMasterKey: true });
        }
        privilegeRoles[action] = res;
    }
    ));
}
async function runBackend() {
    let promises = [];
    await createPrivileges();
    let query = new Parse.Query(ClowdrInstance);
    query.find({ useMasterKey: true }).then((instances) => {
        instances.forEach(
            async (inst) => {
                try {
                    promises.push(getConferenceByID(inst.id).then((conf) => {
                        console.log("Finished " + conf.get("conferenceName"))
                    }).catch(err => {
                        console.log("Unable to load data for  " + inst.get("conferenceName"))
                        console.error(err);
                    }));
                } catch (err) {
                    console.error(err);
                }
            }
        )
    }).catch((err) => {
        console.error(err);
    });


    Promise.all(promises).then(() => {
        app.listen(process.env.PORT || 3001, () =>
            console.log('Express server is running on localhost:3001')
        );
    });
}

runBackend();
