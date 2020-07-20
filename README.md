# clowdr-backend
Token server, Slack bot, REST services for Clowdr

## Set up the environment variables

Start by cloning the repo.

To run the application, you need to configure your credentials in `.env`. If
you are in a Linux or macos environment, the easiest way is to simply add a
symbolic link to the .env file of the web app:

```bash
$ ln -s ../clowdr-web-app/.env .env
```
If you are in another environment, simply copy that file to the root of this directory.

## Install and run

```bash
$ npm install
```
```bash
$ npm start
```

## Enable chat webhooks for twilio

We use a webhook from twilio to track who is online.

Go to your Twilio account, and locate the chat service created by Clowdr,
called `clowdr_chat` (All Products and Services [the circle with three dots
on the left] -> Programmable Chat, then click `clowdr_chat`).

BCP: I don't see clowdr_chat, but i do see the chat i created earlier...
Also, should ngrok be mentioned earlier?

From there:

* Base configuration -> check `Reachability enabled` and `Message read
  status`

* Webhooks -> Post event webhook, callback URL is your backend server
  e.g. https://xxxxx.ngrok.io/twilio/chat/event , HTTP-POST method,
  `onUserUpdated` event only.

* Save

If you are in a development environment, rather than production, you may need to set up a tunnel for Twilio to reach your server. Ngrok will work. Install it and run
```bash
$ ngrok http 3001
```

Note the https URL that ngrok gives you `https://xxxxx.ngrok.io` -- that is the URL that you should use as callback URL in Twilio.

BCP: I don't see a URL that looks like this, or one that looks like the one above...
