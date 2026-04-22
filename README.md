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
