<div v-pre>

# Complete Deployment Guide for OpenHW Studio

This is your ultimate, step-by-step guide to taking your project from GitHub to your live Ubuntu server. Follow these steps in exact order.

---

## Phase 1: GitHub Settings Preparation (In your Web Browser)

Before touching the server, we must configure GitHub to communicate securely with Docker Hub and your future server.

### 1. Set up the `production` Environment
*For **both** `OpenHW-studio-frontend` and `openhw-studio-backend` repositories:*
1. Go to **Settings** > **Environments**.
2. Click **New environment** and name it exactly `production`.
3. Check the box for **Required reviewers** and add your own GitHub username. Click Save.
*(This acts as a safety switch so deployments pause until you approve them).*

### 2. Set up GitHub Secrets
*For **both** repositories:*
1. Go to **Settings** > **Secrets and variables** > **Actions**.
2. Click **New repository secret** and add the following two secrets:
   * **Name:** `DOCKER_USERNAME` | **Secret:** Your Docker Hub username
   * **Name:** `DOCKER_PASSWORD` | **Secret:** Your Docker Hub password
3. **Only in Frontend Repo:** Add one more secret:
   * **Name:** `VITE_ADMIN_EMAILS` | **Secret:** `9661346164h@gmail.com,anotheradmin@gmail.com`
     *(You can add multiple emails by separating them with commas)*

### 3. Generate a GitHub Token (For your Backend `.env`)
1. Click your profile picture (top right) > **Settings** > **Developer settings** > **Personal access tokens** > **Tokens (classic)**.
2. Click **Generate new token (classic)**. Name it `OpenHW-Server-Token`.
3. Check the boxes for `repo` (all of them) and `workflow`.
4. Click **Generate**.
5. > [!WARNING]
   > **COPY THIS TOKEN NOW.** Paste it in a safe notepad. You will need it in Phase 3.

---

## Phase 2: Ubuntu VM Software Installation

SSH into your target Ubuntu VM (through your jumper server).

### 1. Install Docker & Docker Compose
Run these commands one by one in your VM terminal:
```bash
# Update server
sudo apt-get update
sudo apt-get upgrade -y

# Install Docker
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Allow your user to run docker without 'sudo'
sudo usermod -aG docker $USER
newgrp docker
```

### 2. Set up Project Directories
You need to clone your backend repository because it contains the `docker-compose.prod.yml` that orchestrates everything.
```bash
# Make a root folder for your app
sudo mkdir -p /opt/openhw
sudo chown -R $USER:$USER /opt/openhw
cd /opt/openhw

# Clone the backend repository
git clone https://github.com/OpenHW-Studio/openhw-studio-backend.git backend
cd backend
```

---

## Phase 3: Create the `.env` Configuration
You are now inside `/opt/openhw/backend`. Let's create the environment file.

1. Create the file:
   ```bash
   nano .env
   ```
2. Paste the following configuration exactly (replacing placeholders with your actual secrets):
   ```env
   # SERVER PORTS
   PORT=5000

   # DATABASE
   MONGO_URI=mongodb://mongodb:27017/openhw-studio

   # SECURITY SECRETS
   JWT_SECRET=put_a_long_random_string_here_12345
   SESSION_SECRET=put_another_long_random_string_here_67890

   # GOOGLE AUTH
   GOOGLE_CLIENT_ID=439925019035-5qicn1624vopg9emh08dfnpu69b9qfc2.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=YOUR_GOOGLE_SECRET_HERE
   GOOGLE_CALLBACK_URL=https://openhw-studio.fossee.in/auth/google/callback

   # DOMAIN
   ALLOWED_ORIGINS=https://openhw-studio.fossee.in
   FRONTEND_URL=https://openhw-studio.fossee.in

   # FIRMWARE PATHS
   PICO_MICROPYTHON_UART0_UF2_URL=./data/firmware/pico-micropython-uart0.uf2
   PICO_MICROPYTHON_HEX_PATH=./data/firmware/rp2040-micropython-uart.hex
   PICO_CIRCUITPYTHON_UF2_PATH=./data/firmware/adafruit-circuitpython-raspberry_pi_pico-en_US-8.2.7.uf2

   # EXAMPLES
   EXAMPLES_DIR=/app/openhw-studio-examples/examples

   # GITHUB (For Admin Dashboard features)
   GITHUB_ADMIN_TOKEN=YOUR_GITHUB_TOKEN_FROM_PHASE_1
   GITHUB_OWNER=OpenHW-Studio
   GITHUB_REPO_FRONTEND=OpenHW-studio-frontend
   GITHUB_REPO_BACKEND=openhw-studio-backend
   ```
3. Save and exit (`Ctrl+O`, `Enter`, `Ctrl+X`).

---

## Phase 4: Install the GitHub Self-Hosted Runners
Because you have two repositories (frontend and backend), you need two runners listening on your server.

> [!TIP]
> Ensure you run these commands from your home directory (`cd ~`) so they don't clutter your project folder.

### 1. Backend Runner Setup
1. On your PC, go to your **Backend Repo** > **Settings** > **Actions** > **Runners**.
2. Click **New self-hosted runner** > **Linux**.
3. On your VM terminal, run: `cd ~`
4. **Copy/Paste and run the commands provided by GitHub** exactly as shown on the screen (Download, Extract, Configure).
   * When asked for the runner name, just press Enter to accept the default.
   * When asked for labels, just press Enter.
5. Finally, install it as a background service:
   ```bash
   sudo ./svc.sh install
   sudo ./svc.sh start
   ```

### 2. Frontend Runner Setup
1. On your PC, go to your **Frontend Repo** > **Settings** > **Actions** > **Runners**.
2. Click **New self-hosted runner** > **Linux**.
3. On your VM terminal, run: `cd ~`
4. **Important:** Create a *different* folder for this runner so it doesn't overwrite the backend one!
   ```bash
   mkdir frontend-runner && cd frontend-runner
   ```
5. Skip GitHub's `mkdir` command, but **Copy/Paste and run the rest of the commands** (Download, Extract, Configure) from the GitHub screen.
6. Install it as a background service:
   ```bash
   sudo ./svc.sh install
   sudo ./svc.sh start
   ```

---

## Phase 5: The First Deployment!

You are ready! Your server is listening for commands from GitHub.

1. Go to your local computer terminal (where you code).
2. Go to your root `simulator` folder.
3. Commit and push everything:
   ```bash
   git add .
   git commit -m "Final production configuration"
   git push origin develop
   ```
   *(Also push from your frontend repo if needed)*
4. Go to the **Actions** tab on your GitHub repositories.
5. You will see the `deploy.yml` workflow running.
6. Once the build finishes, it will pause. A yellow banner will appear asking for **Review**.
7. Click it, approve the deployment, and watch as GitHub pings your VM, your VM pulls the Docker image, and your server goes live!

---

## Phase 6: Infrastructure Monitoring & Security

The Admin Dashboard now includes real-time infrastructure monitoring. For this to work securely:

### 1. Docker Socket Security
The backend container is configured to mount `/var/run/docker.sock`. This allows the dashboard to:
*   Show real-time CPU/RAM usage of your services.
*   Allow you to restart services (Frontend, Backend, MongoDB) directly from the UI.
*   View live system logs.

### 2. Troubleshooting "N/A" or Disconnected States
If the Admin Dashboard shows "N/A" for stats or "Disconnected" for services:
1.  **Check Socket Permissions**: On your VM, ensure the Docker socket is accessible:
    ```bash
    ls -l /var/run/docker.sock
    # It should be owned by root:docker
    ```
2.  **Verify User Groups**: Ensure your VM user is in the `docker` group (see Phase 2).
3.  **Redeploy Backend**: If you just updated the `Dockerfile` or `docker-compose.prod.yml`, you must rebuild:
    ```bash
    cd /opt/openhw/backend
    docker compose -f docker-compose.prod.yml up -d --build backend
    ```

---

## Phase 7: Health Monitoring & Notifications

This phase covers the deployment of the **Unified Health Agent**, which provides real-time watchdog alerts, two-stage deployment notifications, and hourly rich-media performance reports.

### 1. Telegram Bot Setup
1.  Message **@BotFather** on Telegram.
2.  Create a new bot using `/newbot` and get your `TELEGRAM_BOT_TOKEN`.
3.  Set bot privacy: `/setprivacy` -> **Enabled** (Ensures it ignores random messages).
4.  Disable groups: `/setjoingroups` -> **Disabled**.
5.  Get your `TELEGRAM_CHAT_ID` by messaging **@IDBot** or using a tool like [GetIDs](https://t.me/getidsbot).

### 2. GitHub Secrets Configuration
Add the following secrets to **ALL** 4 repositories under `Settings > Secrets and variables > Actions`:
*   `TELEGRAM_BOT_TOKEN`: The token from BotFather.
*   `TELEGRAM_CHAT_ID`: Your personal Telegram ID.
*   `NOTIFY_SECRET`: A long random string (must match the one in your server's `.env`).

### 3. Server-Side Configuration
Ensure your `/opt/openhw/backend/.env` file contains the following:
```env
TELEGRAM_BOT_TOKEN=your_token_here
TELEGRAM_CHAT_ID=your_id_here
NOTIFY_SECRET=your_random_secret_here
```

### 4. Deploying the Agent
The Health Agent is deployed as a sidecar container. Run the following on the production VM:

```bash
cd /opt/openhw/backend
git pull origin develop
docker compose -f docker-compose.prod.yml up -d --build health-agent
```

### 5. Multi-Stage Notification Flow
*   **Stage 1 (Build Ready)**: When you push code, you get a message: *"Build Successful: Waiting for Deployment Approval."*
*   **Stage 2 (Deployed)**: After you click **Approve** in GitHub Actions, you get a second message: *"Deployment Successful"* with the **Version SHA**.

### 6. Verification & Monitoring
*   **Watchdog**: Stop a minor container (e.g., `frontend`) and wait 5 minutes. You should receive an instant "CRITICAL" alert on Telegram.
*   **Hourly Report**: Every hour (at :00), you will receive an HTML file. Open it to see the Uptime Kuma-style dashboard with 40-day history.
*   **Image Tracking**: In the HTML report, select a container to see its **Image ID** and **Version Tag**.
*   **Log Security**: Verify that sensitive data like JWTs are replaced with `[MASKED]` in the log view.

### 7. Maintenance
*   **History**: The agent stores 40 days of history in `backend/health-agent/history.json`. This file is rotated automatically.
*   **Updates**: To update the agent or the report design, simply `git pull` and restart the `health-agent` container.

---

## Phase 8: Deploying the Documentation Portal (Unified)

The documentation is now integrated into the main frontend deployment. It is built as a static site and served via Nginx from the `/docs/` path.

### 1. GitHub Actions Setup
Update your **Frontend Repo** `deploy.yml` workflow to checkout the documentation repository. Add this step after the other checkouts:

```yaml
      - name: Checkout documentation code
        uses: actions/checkout@v4
        with:
          repository: OpenHW-Studio/openhw-studio-docs
          path: openhw-studio-docs
          token: ${{ secrets.GITHUB_TOKEN }}
```

### 2. Automatic Deployment
Once the workflow is updated, every time you deploy the frontend, the documentation will be automatically built and served at:
`https://openhw-studio.fossee.in/docs/`

### 3. Update Frontend Configuration
Ensure your `backend/.env` (which the frontend uses during build/deploy) points to the relative or absolute production path:
```env
VITE_DOCS_URL=https://openhw-studio.fossee.in/docs/
```

---

## Security Best Practices
*   **Never** share your `GITHUB_ADMIN_TOKEN` or `JWT_SECRET`.
*   **Restrict SSH**: Only allow SSH access to your VM through the jumper server or specific IP addresses.
*   **Audit Logs**: Regularly check the "History" tab in the Admin Dashboard to review administrative actions.






</div>
