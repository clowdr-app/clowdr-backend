# clowdr-backend
Slack bot and REST services for clowdr

## Configure Twilio chat server 

To run the application, you should have your credentials and configure it in `.env`. To create this file from template, you could do this in your terminal.

```bash
cp .env.example .env
```

### Configure Twilio account info

| Config Value | Description |
| ------------ | ----------- |
| `TWILIO_ACCOUNT_SID` | [Your primary Twilio account identifier](https://www.twilio.com/console).|
|`TWILIO_API_KEY` | [Used to authenticate](https://www.twilio.com/console/dev-tools/api-keys).|
|`TWILIO_API_SECRET` | [Used to authenticate](https://www.twilio.com/console/dev-tools/api-keys).|
|`TWILIO_CHAT_SERVICE_SID` | [Chat](https://www.twilio.com/console/chat/services)|

### Enable chat webhooks for twilio
We use a webhook from twilio to track who is online.
From your Twilio programmable chat service dashboard:
* Base configuration -> Enable reachability, message read status
* Webhooks -> Post event webhook, callback URL is your backend server e.g. https://back.clowdr.org/twilio/chat/event , HTTP-POST method, `onUserUpdated` event only.
* Save

### Configure Parse account info

In the same `.env`, you should configure Parse info based on this [instruction](https://github.com/clowdr-app/clowdr-web-app/blob/master/README.md).

### Configure  `TWILIO_CALLBACK_URL`

You'll need to create a publicly accessible URL using a tool like [Ngrok](https://ngrok.com/) to send HTTP/HTTPS traffic to a server running on your localhost. Use HTTPS to make web connections that retrieve a Twilio access token.

Our backend server runs on `port 3001`, so you should do this in your Ngrok CLI.

```bash
ngrok http 3001
```

Then you should copy the https tunnel link and paste it into both `.env` file in this app and in [clowdr-web-app](https://github.com/clowdr-app/clowdr-web-app) with the name of `REACT_APP_TWILIO_CALLBACK_URL`.

###  Configure `App.js`

In your `Session` table, make sure that you only have exact one entry. If you don't have one right now, you could log in [clowdr-web-app](https://github.com/clowdr-app/clowdr-web-app) to create one and if you have more than one, you could just delete others.

#### Configure `userId`

Due to privilege restriction of Parse, we need to assign our `userId` in the app. Go to the `User` table and copy your `objectId` at [line 2145](https://github.com/clowdr-app/clowdr-backend/blob/master/app.js#L2145).

```javascript
fauxUser.id = "YOUR USER OBJECID";
```

#### For non-slack users

Since some credentials are fetched from slack app, you need to load them in them in your `env` by changing [line 1965](https://github.com/clowdr-app/clowdr-backend/blob/master/app.js#L1965) as below.

```js
const accessToken = new AccessToken(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_API_KEY, process.env.TWILIO_API_SECRET,{ttl: 3600*24});
```

Moreover, you should comment out all codes from [line 545](https://github.com/clowdr-app/clowdr-backend/blob/master/app.js#L545) to line 555.

```javascript
// Comment out codes below if you don't connect this app to your slack app
let allChannels = await r.config.slackClient.conversations.list({types: "private_channel,public_channel"});
for(let channel of allChannels.channels){
    if(channel.name=="moderators"){
        r.moderatorChannel = channel.id;
    }
    else if(channel.name =="technical-support"){
        r.techSupportChannel = channel.id;
    }else if(channel.name=="session-help"){
        r.sessionHelpChannel = channel.id;
    }
}
```

Now, use `npm install` to install all dependencies and use `npm start` to run the app. If you see `POST - code 200` in your Ngrok CLI and a token in that response, you are good to go!

