## Copilot Auto-Runner

In situations where one needs to test copilot by sending prompts to it and getting responses, this script can be used to do that in an automated way, it saves the user from manually typing the prompts and waiting for the responses. It works by using a library called playwright which automatically opens a chrome browser and sends prompts to copilot and prints responses on screen.

### Windows

1. **Open the folder** where the files are located.
2. **Double‑click `run_copilot.bat`** (or run it from Command Prompt).

### macOS

You need homebrew installed on your mac if you want the script to automatically install required software

1. Open **Terminal** in the folder with the files.
2. Make the script executable (first time only):
   - `chmod +x run_copilot.sh`
3. Run it:
   - `./run_copilot.sh`

### What happens
1. **First time only:** it installs required software (Node.js, Chrome browser used by the script, and some more).
2. **Login step:** a Chrome window may open so you can sign in to Office.com.
   - If your session expires later, it will open again.
3. **Close automatically:** after you log in, the browser closes on its own.
4. **Automatic prompts:** the script starts sending prompts to Copilot and prints responses on screen.
   - By default it runs **2 prompts in parallel**.
   - To change the number, pass a number when you run it:
     - Windows: `run_copilot.bat 10` (runs 10 prompts in parallel)
     - macOS: `run_copilot.sh 10` (runs 10 prompts in parallel)

### Logs & troubleshooting
- On any failure, debug files are saved in a **`tmp/`** folder in the same directory.
- You can **zip the `tmp/` folder** and send it for debugging.

### Stopping the script
- Press **Ctrl+C** at any time to stop.
- It will still write the same logs/HAR files before exiting.
