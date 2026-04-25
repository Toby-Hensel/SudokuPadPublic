# SudokuPad Party

This project can now run in two ways:

- locally on your own computer
- publicly on the internet so anyone can join with one link

## Public internet version

The easiest real public setup is Render.

### What other people need

They do not need to install anything.

Once the site is deployed, they only open the public link in a browser.

### Simple public deploy steps

1. Put this folder into a GitHub repository.
2. Go to [Render](https://render.com/).
3. Sign in.
4. Click `New +`.
5. Click `Blueprint`.
6. Connect your GitHub account if Render asks.
7. Pick the repository with this project.
8. Render should detect `render.yaml`.
9. Approve the deploy.
10. Wait for Render to finish.
11. Open the public `onrender.com` URL Render gives you.
12. Paste a SudokuPad link, create a collaboration link, and send that link to anyone you want.

### After that

Render is now configured to redeploy automatically on every push to the linked branch.

That means:

- you push changes to GitHub
- Render notices the new commit
- Render rebuilds and updates the public server automatically

### Cold-start fix

Render free web services can still spin down after 15 minutes of no traffic.

This repo now includes a Render cron service in [render.yaml](/C:/Users/rubie/Documents/Codex/2026-04-22-i-would-like-you-to-create/render.yaml) that pings:

- `https://sudokupad-party.onrender.com/api/health`

every 10 minutes to keep the public site warm.

Important:

- the keep-warm cron job is a separate Render service
- Render cron jobs have a minimum charge of $1/month
- if you rename the service or use a custom domain, update `WARM_TARGET_URL`
- the stronger long-term fix is upgrading the web service itself from `Free` to `Starter`, which avoids free-tier sleep entirely

### Better camera and microphone reliability

The app now supports real TURN relays for WebRTC.

If you want the best chance of camera/audio working across different networks, add these environment variables to the Render web service:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_TURN_TTL`
- `TWILIO_TURN_REGION` (optional)

How it works:

- if those Twilio credentials are present, the server fetches short-lived TURN credentials and gives them to the browser when someone joins AV
- if they are not present, the app falls back to the built-in ICE list, which is still okay for local testing and some public sessions

Recommended starting values:

- `TWILIO_TURN_TTL=3600`
- leave `TWILIO_TURN_REGION` blank unless you specifically want to pin Twilio to one region

After adding them in Render:

1. Save the environment variables.
2. Trigger a redeploy.
3. Test the AV join flow again from two different networks.

### Files added for public hosting

- `render.yaml`
- `Dockerfile`
- `.gitignore`
- `.dockerignore`

## Local version

This folder is also self-contained for local use.

It includes:

- the website files
- the server file
- a local copy of `node.exe` in `runtime\node`
- simple launcher files

### Easiest local start

1. Open this folder.
2. Double-click `Open SudokuPad Party.bat`.
3. Wait a moment.
4. Your browser should open automatically.
5. If it does not, open `http://localhost:3000`.

## How to use the site

1. Paste a SudokuPad link or puzzle ID.
2. Click `Create collaboration link`.
3. Open that link.
4. Send the same link to anyone else who should join.

## Important

- Keep the server window open while using the site.
- To stop the server, close that server window.
- If you share the folder itself, keep it together exactly as it is.

## Current production note

Rooms are stored in server memory right now.

That means:

- one deployed server works fine
- if the server restarts, room state resets
- the next upgrade for a more durable production setup would be Redis or another shared store

## Manual keep-warm test

You can run the keep-warm ping locally with:

```powershell
$env:WARM_TARGET_URL='https://sudokupad-party.onrender.com/api/health'
.\runtime\node\node.exe scripts\keep-warm.mjs
Remove-Item Env:WARM_TARGET_URL
```
