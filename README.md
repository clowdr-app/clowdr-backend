# clowdr-backend
Token server, Slack bot, REST services for Clowdr

## Set up the environment variables 

To run the application, you should have your credentials and configure them in `.env`. If you are in a Linux environment, the easiest way is to simply add a symbolic link to the .env file of the web app:

```bash
ln -s ../clowdr-web-app/.env .env
```
If you are in another environment, simply copy that file to the root of this directory.

## Install and run

```bash
npm install
```
```bash
npm start
```

### Enable chat webhooks for twilio
We use a webhook from twilio to track who is online.
From your Twilio programmable chat service dashboard:
* Base configuration -> Enable reachability, message read status
* Webhooks -> Post event webhook, callback URL is your backend server e.g. https://back.clowdr.org/twilio/chat/event , HTTP-POST method, `onUserUpdated` event only.
* Save


