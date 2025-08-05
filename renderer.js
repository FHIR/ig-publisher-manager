const ipcRenderer = require('electron').ipcRenderer;
const fs = require('fs');
const path = require('path');

// Application state
let igList = [];
let selectedIgIndex = -1;
let optionsPanelVisible = false;
let buildProcesses = new Map();
let fileWatcher = null;

// Sort state
let sortState = {
    column: null,        // Currently sorted column
    direction: 'asc',    // 'asc' or 'desc'
    columnMap: {         // Map display names to data properties
        'Name': 'name',
        'Version': 'version',
        'Git Branch': 'gitBranch',
        'Folder': 'folder',
        'Build Status': 'buildStatus',
        'Build Time': 'buildTime',
        'Built Size': 'builtSize',
        'Last Build': 'lastBuildStart'
    }
};

// DOM elements
let igListBody;
let buildOutput;
let optionsPanel;
let toggleButton;

// Console management for each IG
function initializeIgConsole(ig) {
    if (!ig.console) {
        ig.console = '';
    }

// Settings management
function saveSettings() {
    try {
        const settings = {
            terminologyServer: document.getElementById('terminology-server').value,
            igPublisherVersion: document.getElementById('ig-publisher-version').value,
            maxMemory: document.getElementById('max-memory').value,
            noNarrative: document.getElementById('no-narrative').checked,
            noValidation: document.getElementById('no-validation').checked,
            noNetwork: document.getElementById('no-network').checked,
            noSushi: document.getElementById('no-sushi').checked,
            debugging: document.getElementById('debugging').checked
        };
        
        localStorage.setItem('igPublisherSettings', JSON.stringify(settings));
    } catch (error) {
        console.log('Could not save settings:', error);
    }
}

function loadSettings() {
    try {
        const settings = JSON.parse(localStorage.getItem('igPublisherSettings') || '{}');
        
        if (settings.terminologyServer) {
            document.getElementById('terminology-server').value = settings.terminologyServer;
        }
        if (settings.igPublisherVersion) {
            document.getElementById('ig-publisher-version').value = settings.igPublisherVersion;
        }
        if (settings.maxMemory) {
            document.getElementById('max-memory').value = settings.maxMemory;
        } else {
            document.getElementById('max-memory').value = '8'; // Default to 8GB
        }
        
        document.getElementById('no-narrative').checked = settings.noNarrative || false;
        document.getElementById('no-validation').checked = settings.noValidation || false;
        document.getElementById('no-network').checked = settings.noNetwork || false;
        document.getElementById('no-sushi').checked = settings.noSushi || false;
        document.getElementById('debugging').checked = settings.debugging || false;

        loadSortState();
    } catch (error) {
        console.log('Could not load settings:', error);
    }
}

// IG Publisher JAR management
async function getJarPath(version) {
    // Get the user data directory for storing JARs
    const userDataPath = await ipcRenderer.invoke('get-user-data-path');
    const jarsDir = path.join(userDataPath, 'jars');
    
    // Ensure jars directory exists
    if (!fs.existsSync(jarsDir)) {
        fs.mkdirSync(jarsDir, { recursive: true });
    }
    
    const jarFileName = 'validator_cli_' + version + '.jar';
    return path.join(jarsDir, jarFileName);
}

async function ensureJarExists(version, downloadUrl, ig) {
    const jarPath = await getJarPath(version);

    if (fs.existsSync(jarPath)) {
        appendToIgConsole(ig, 'Using existing JAR: ' + jarPath);
        return jarPath;
    }

    appendToIgConsole(ig, 'Downloading IG Publisher version ' + version + '...');

    try {
        // Try multiple download methods for Windows compatibility
        await downloadJarWithFallbacks(downloadUrl, jarPath, ig);

        const stats = fs.statSync(jarPath);
        appendToIgConsole(ig, 'Downloaded JAR: ' + (stats.size / 1024 / 1024).toFixed(1) + ' MB');

        return jarPath;
    } catch (error) {
        appendToIgConsole(ig, 'Failed to download JAR: ' + error.message);
        throw error;
    }
}

async function downloadJarWithFallbacks(downloadUrl, jarPath, ig) {
    const downloadMethods = [
        () => downloadWithFetch(downloadUrl, jarPath, ig),
        () => downloadWithNode(downloadUrl, jarPath, ig),
        () => downloadFromDirectUrl(downloadUrl, jarPath, ig)
    ];

    let lastError;

    for (let i = 0; i < downloadMethods.length; i++) {
        try {
            appendToIgConsole(ig, `Trying download method ${i + 1}...`);
            await downloadMethods[i]();
            return; // Success!
        } catch (error) {
            lastError = error;
            appendToIgConsole(ig, `Method ${i + 1} failed: ${error.message}`);
        }
    }

    throw new Error(`All download methods failed. Last error: ${lastError.message}`);
}

// Method 1: Standard fetch with HTTP/1.1 fallback
async function downloadWithFetch(downloadUrl, jarPath, ig) {
    appendToIgConsole(ig, 'Using fetch download method...');

    const response = await fetch(downloadUrl, {
        headers: {
            'User-Agent': 'IG-Publisher-Manager',
            'Accept': 'application/octet-stream',
            'Connection': 'keep-alive',
            // Force HTTP/1.1 to avoid HTTP/2 issues on Windows
            'HTTP2-Settings': ''
        }
    });

    if (!response.ok) {
        throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    fs.writeFileSync(jarPath, buffer);
}

// Method 2: Use Node.js https module directly
async function downloadWithNode(downloadUrl, jarPath, ig) {
    return new Promise((resolve, reject) => {
        appendToIgConsole(ig, 'Using Node.js HTTPS download method...');

        const https = require('https');
        const url = require('url');
        const fs = require('fs');

        const parsedUrl = url.parse(downloadUrl);

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 443,
            path: parsedUrl.path,
            method: 'GET',
            headers: {
                'User-Agent': 'IG-Publisher-Manager',
                'Accept': 'application/octet-stream'
            },
            // Force HTTP/1.1
            protocol: 'https:',
            secureProtocol: 'TLSv1_2_method'
        };

        const req = https.request(options, (res) => {
            if (res.statusCode === 302 || res.statusCode === 301) {
                // Handle redirect
                return downloadWithNode(res.headers.location, jarPath, ig)
                  .then(resolve)
                  .catch(reject);
            }

            if (res.statusCode !== 200) {
                reject(new Error(`Download failed: ${res.statusCode} ${res.statusMessage}`));
                return;
            }

            const fileStream = fs.createWriteStream(jarPath);
            res.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close();
                resolve();
            });

            fileStream.on('error', (err) => {
                fs.unlink(jarPath, () => {}); // Delete partial file
                reject(err);
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        req.setTimeout(30000, () => {
            req.abort();
            reject(new Error('Download timeout'));
        });

        req.end();
    });
}

// Method 3: Try to get a simpler direct URL from GitHub
async function downloadFromDirectUrl(originalUrl, jarPath, ig) {
    appendToIgConsole(ig, 'Trying direct GitHub URL method...');

    // If this is a GitHub release asset URL, try to get the direct download
    if (originalUrl.includes('release-assets.githubusercontent.com')) {
        // Extract the filename and try the direct API approach
        const filenameMatch = originalUrl.match(/filename%3D([^&]+)/);
        if (filenameMatch) {
            const filename = decodeURIComponent(filenameMatch[1]);
            appendToIgConsole(ig, `Detected filename: ${filename}`);

            // For publisher.jar, try the known direct URL
            if (filename === 'publisher.jar') {
                const directUrl = 'https://github.com/HL7/fhir-ig-publisher/releases/latest/download/publisher.jar';
                appendToIgConsole(ig, `Trying direct URL: ${directUrl}`);

                return downloadWithNode(directUrl, jarPath, ig);
            }
        }
    }

    throw new Error('Could not determine direct download URL');
}

function buildIgPublisherCommand(ig, jarPath) {
    const settings = getCurrentSettings();
    
    const command = ['java'];
    
    // Add memory setting
    command.push('-Xmx' + settings.maxMemory + 'G');
    
    // Add JAR
    command.push('-jar');
    command.push(jarPath);
    
    // Add IG folder
    command.push('-ig');
    command.push(ig.folder);
    
    // Add optional parameters
    if (settings.terminologyServer && settings.terminologyServer.trim()) {
        command.push('-tx');
        command.push(settings.terminologyServer.trim());
    }
    
    if (settings.noNarrative) {
        command.push('-no-narrative');
    }
    
    if (settings.noValidation) {
        command.push('-no-validation');
    }
    
    if (settings.noNetwork) {
        command.push('-no-network');
    }
    
    if (settings.noSushi) {
        command.push('-no-sushi');
    }
    
    if (settings.debugging) {
        command.push('-debug');
    }
    
    return command;
}

function getCurrentSettings() {
    return {
        terminologyServer: document.getElementById('terminology-server').value,
        igPublisherVersion: document.getElementById('ig-publisher-version').value,
        maxMemory: document.getElementById('max-memory').value,
        noNarrative: document.getElementById('no-narrative').checked,
        noValidation: document.getElementById('no-validation').checked,
        noNetwork: document.getElementById('no-network').checked,
        noSushi: document.getElementById('no-sushi').checked,
        debugging: document.getElementById('debugging').checked
    };
}

async function ensureJarExists(version, downloadUrl, ig) {
    const jarPath = await getJarPath(version);
    
    if (fs.existsSync(jarPath)) {
        appendToIgConsole(ig, 'Using existing JAR: ' + jarPath);
        return jarPath;
    }
    
    appendToIgConsole(ig, 'Downloading IG Publisher version ' + version + '...');
    appendToIgConsole(ig, 'Download URL: ' + downloadUrl);
    
    try {
        const response = await fetch(downloadUrl);
        if (!response.ok) {
            throw new Error('Download failed: ' + response.status + ' ' + response.statusText);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        fs.writeFileSync(jarPath, buffer);
        appendToIgConsole(ig, 'Downloaded JAR to: ' + jarPath);
        appendToIgConsole(ig, 'JAR size: ' + (buffer.length / 1024 / 1024).toFixed(1) + ' MB');
        
        return jarPath;
    } catch (error) {
        appendToIgConsole(ig, 'Failed to download JAR: ' + error.message);
        throw error;
    }
}

function buildIgPublisherCommand(ig, jarPath) {
    const settings = getCurrentSettings();
    
    const command = ['java'];
    
    // Add memory setting
    command.push('-Xmx' + settings.maxMemory + 'G');
    
    // Add JAR
    command.push('-jar');
    command.push(jarPath);
    
    // Add IG folder
    command.push('-ig');
    command.push(ig.folder);
    
    // Add optional parameters
    if (settings.terminologyServer && settings.terminologyServer.trim()) {
        command.push('-tx');
        command.push(settings.terminologyServer.trim());
    }
    
    if (settings.noNarrative) {
        command.push('-no-narrative');
    }
    
    if (settings.noValidation) {
        command.push('-no-validation');
    }
    
    if (settings.noNetwork) {
        command.push('-no-network');
    }
    
    if (settings.noSushi) {
        command.push('-no-sushi');
    }
    
    if (settings.debugging) {
        command.push('-debug');
    }
    
    return command;
}

function getCurrentSettings() {
    return {
        terminologyServer: document.getElementById('terminology-server').value,
        igPublisherVersion: document.getElementById('ig-publisher-version').value,
        maxMemory: document.getElementById('max-memory').value,
        noNarrative: document.getElementById('no-narrative').checked,
        noValidation: document.getElementById('no-validation').checked,
        noNetwork: document.getElementById('no-network').checked,
        noSushi: document.getElementById('no-sushi').checked,
        debugging: document.getElementById('debugging').checked
    };
}
}

function resetIgConsole(ig, commandGroup) {
    initializeIgConsole(ig);
    ig.console = '=== Starting ' + commandGroup + ' ===\n';
    if (ig === getSelectedIg()) {
        updateBuildOutputDisplay();
    }
}

function appendToIgConsole(ig, text) {
    initializeIgConsole(ig);
    const timestamp = new Date().toLocaleTimeString();
    ig.console += '[' + timestamp + '] ' + text + '\n';
    
    if (ig === getSelectedIg()) {
        updateBuildOutputDisplay();
    }
}

function updateBuildOutputDisplay() {
    const ig = getSelectedIg();
    if (ig && buildOutput) {
        initializeIgConsole(ig);
        buildOutput.textContent = ig.console;
        buildOutput.scrollTop = buildOutput.scrollHeight;
    } else if (buildOutput) {
        buildOutput.textContent = 'No IG selected';
    }
}

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    console.log('Starting app...');
    
    // Get DOM elements
    igListBody = document.getElementById('ig-list-body');
    buildOutput = document.getElementById('build-output');
    optionsPanel = document.getElementById('options-panel');
    toggleButton = document.getElementById('btn-toggle-options');
    
    // Setup event listeners (now settings functions are defined above)
    setupEventListeners();
    setupContextMenus();
    setupResizer();
    setupBuildOutput();
    
    // Load data
    loadSettings();
    loadIgList();
    updateIgList();
    updateButtonStates();
    restorePanelHeights();
    startFileWatcher();

    // Load publisher versions in background
    setTimeout(function() {

        loadPublisherVersions().then(function() {
        }).catch(function(error) {
            console.log('loadPublisherVersions failed:', error);
            appendToBuildOutput('Version loading error: ' + error.message);
        });
    }, 2000);
});

// Settings management
function saveSettings() {
    try {
        const settings = {
            terminologyServer: document.getElementById('terminology-server').value,
            igPublisherVersion: document.getElementById('ig-publisher-version').value,
            maxMemory: document.getElementById('max-memory').value,
            noNarrative: document.getElementById('no-narrative').checked,
            noValidation: document.getElementById('no-validation').checked,
            noNetwork: document.getElementById('no-network').checked,
            noSushi: document.getElementById('no-sushi').checked,
            debugging: document.getElementById('debugging').checked
        };
        
        localStorage.setItem('igPublisherSettings', JSON.stringify(settings));
    } catch (error) {
        console.log('Could not save settings:', error);
    }
}

function loadSettings() {
    try {
        const settings = JSON.parse(localStorage.getItem('igPublisherSettings') || '{}');
        
        if (settings.terminologyServer) {
            document.getElementById('terminology-server').value = settings.terminologyServer;
        }
        if (settings.igPublisherVersion) {
            document.getElementById('ig-publisher-version').value = settings.igPublisherVersion;
        }
        if (settings.maxMemory) {
            document.getElementById('max-memory').value = settings.maxMemory;
        } else {
            document.getElementById('max-memory').value = '8'; // Default to 8GB
        }
        
        document.getElementById('no-narrative').checked = settings.noNarrative || false;
        document.getElementById('no-validation').checked = settings.noValidation || false;
        document.getElementById('no-network').checked = settings.noNetwork || false;
        document.getElementById('no-sushi').checked = settings.noSushi || false;
        document.getElementById('debugging').checked = settings.debugging || false;
    } catch (error) {
        console.log('Could not load settings:', error);
    }
}

function getCurrentSettings() {
    return {
        terminologyServer: document.getElementById('terminology-server').value,
        igPublisherVersion: document.getElementById('ig-publisher-version').value,
        maxMemory: document.getElementById('max-memory').value,
        noNarrative: document.getElementById('no-narrative').checked,
        noValidation: document.getElementById('no-validation').checked,
        noNetwork: document.getElementById('no-network').checked,
        noSushi: document.getElementById('no-sushi').checked,
        debugging: document.getElementById('debugging').checked
    };
}

async function getJarPath(version) {
    const userDataPath = await ipcRenderer.invoke('get-user-data-path');
    const jarsDir = path.join(userDataPath, 'jars');
    
    if (!fs.existsSync(jarsDir)) {
        fs.mkdirSync(jarsDir, { recursive: true });
    }
    
    const jarFileName = 'validator_cli_' + version + '.jar';
    return path.join(jarsDir, jarFileName);
}

async function ensureJarExists(version, downloadUrl, ig) {
    const jarPath = await getJarPath(version);
    
    if (fs.existsSync(jarPath)) {
        appendToIgConsole(ig, 'Using existing JAR: ' + jarPath);
        return jarPath;
    }
    
    appendToIgConsole(ig, 'Downloading IG Publisher version ' + version + '...');
    
    try {
        const response = await fetch(downloadUrl);
        if (!response.ok) {
            throw new Error('Download failed: ' + response.status);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        fs.writeFileSync(jarPath, buffer);
        appendToIgConsole(ig, 'Downloaded JAR: ' + (buffer.length / 1024 / 1024).toFixed(1) + ' MB');
        
        return jarPath;
    } catch (error) {
        appendToIgConsole(ig, 'Failed to download JAR: ' + error.message);
        throw error;
    }
}

function buildIgPublisherCommand(ig, jarPath) {
    const settings = getCurrentSettings();
    
    const command = ['java'];
    command.push('-Xmx' + settings.maxMemory + 'G');
    command.push('-jar');
    command.push(jarPath);
    command.push('-ig');
    command.push(ig.folder);
    
    if (settings.terminologyServer && settings.terminologyServer.trim()) {
        command.push('-tx');
        command.push(settings.terminologyServer.trim());
    }
    
    if (settings.noNarrative) command.push('-no-narrative');
    if (settings.noValidation) command.push('-no-validation');
    if (settings.noNetwork) command.push('-no-network');
    if (settings.noSushi) command.push('-no-sushi');
    if (settings.debugging) command.push('-debug');
    
    return command;
}

function setupEventListeners() {
    // Toolbar buttons
    document.getElementById('btn-add-folder').addEventListener('click', addFolder);
    document.getElementById('btn-add-github').addEventListener('click', addFromGitHub);
    document.getElementById('btn-delete').addEventListener('click', deleteIg);
    document.getElementById('btn-build').addEventListener('click', buildIg);
    document.getElementById('btn-stop').addEventListener('click', stopBuild);
    document.getElementById('btn-open-ig').addEventListener('click', openIG);
    document.getElementById('btn-open-qa').addEventListener('click', openQA);
    document.getElementById('btn-copy').addEventListener('click', showCopyMenu);
    document.getElementById('btn-update').addEventListener('click', updateSource);
    document.getElementById('btn-tools').addEventListener('click', showToolsMenu);
    document.getElementById('btn-toggle-options').addEventListener('click', toggleOptionsPanel);

    // Settings change listeners
    document.getElementById('terminology-server').addEventListener('change', saveSettings);
    document.getElementById('ig-publisher-version').addEventListener('change', saveSettings);
    document.getElementById('max-memory').addEventListener('change', saveSettings);
    document.getElementById('no-narrative').addEventListener('change', saveSettings);
    document.getElementById('no-validation').addEventListener('change', saveSettings);
    document.getElementById('no-network').addEventListener('change', saveSettings);
    document.getElementById('no-sushi').addEventListener('change', saveSettings);
    document.getElementById('debugging').addEventListener('change', saveSettings);

    // Close context menus when clicking elsewhere
    document.addEventListener('click', closeContextMenus);
    document.getElementById('btn-documentation').addEventListener('click', showDocumentationMenu);

    setupColumnHeaderListeners();
}

// Settings management
function saveSettings() {
    try {
        const settings = {
            terminologyServer: document.getElementById('terminology-server').value,
            igPublisherVersion: document.getElementById('ig-publisher-version').value,
            maxMemory: document.getElementById('max-memory').value,
            noNarrative: document.getElementById('no-narrative').checked,
            noValidation: document.getElementById('no-validation').checked,
            noNetwork: document.getElementById('no-network').checked,
            noSushi: document.getElementById('no-sushi').checked,
            debugging: document.getElementById('debugging').checked
        };
        
        localStorage.setItem('igPublisherSettings', JSON.stringify(settings));
    } catch (error) {
        console.log('Could not save settings:', error);
    }
}

function loadSettings() {
    try {
        const settings = JSON.parse(localStorage.getItem('igPublisherSettings') || '{}');
        
        if (settings.terminologyServer) {
            document.getElementById('terminology-server').value = settings.terminologyServer;
        }
        if (settings.igPublisherVersion) {
            document.getElementById('ig-publisher-version').value = settings.igPublisherVersion;
        }
        if (settings.maxMemory) {
            document.getElementById('max-memory').value = settings.maxMemory;
        } else {
            document.getElementById('max-memory').value = '8'; // Default to 8GB
        }
        
        document.getElementById('no-narrative').checked = settings.noNarrative || false;
        document.getElementById('no-validation').checked = settings.noValidation || false;
        document.getElementById('no-network').checked = settings.noNetwork || false;
        document.getElementById('no-sushi').checked = settings.noSushi || false;
        document.getElementById('debugging').checked = settings.debugging || false;
    } catch (error) {
        console.log('Could not load settings:', error);
    }
}

function setupContextMenus() {
    // Tools menu items
    const toolsMenuItems = document.querySelectorAll('#tools-menu .context-menu-item');
    for (let i = 0; i < toolsMenuItems.length; i++) {
        toolsMenuItems[i].addEventListener('click', function(e) {
            const action = e.target.dataset.action;
            handleToolsAction(action);
            closeContextMenus();
        });
    }
}

// Basic functions
function appendToBuildOutput(text) {
    const ig = getSelectedIg();
    if (ig) {
        appendToIgConsole(ig, text);
    } else if (buildOutput) {
        const timestamp = new Date().toLocaleTimeString();
        buildOutput.textContent += '[' + timestamp + '] ' + text + '\n';
        buildOutput.scrollTop = buildOutput.scrollHeight;
    }
}

function getSelectedIg() {
    if (selectedIgIndex >= 0 && selectedIgIndex < igList.length) {
        return igList[selectedIgIndex];
    }
    return null;
}

// IG Publisher JAR management and execution
async function getJarPath(version) {
    // Get the user data directory for storing JARs
    const userDataPath = await ipcRenderer.invoke('get-user-data-path');
    const jarsDir = path.join(userDataPath, 'jars');
    
    // Ensure jars directory exists
    if (!fs.existsSync(jarsDir)) {
        fs.mkdirSync(jarsDir, { recursive: true });
    }
    
    const jarFileName = 'validator_cli_' + version + '.jar';
    return path.join(jarsDir, jarFileName);
}

function updateIgList() {
    if (!igListBody) return;
    sortIgList();

    igListBody.innerHTML = '';
    
    for (let i = 0; i < igList.length; i++) {
        const ig = igList[i];
        const row = document.createElement('tr');
        if (i === selectedIgIndex) {
            row.classList.add('selected');
        }
        
        const index = i; // Capture for closure
        row.addEventListener('click', function() {
            selectedIgIndex = index;
            updateIgList();
            updateBuildOutputDisplay();
            updateButtonStates();
        });

        // Right click - show context menu
        row.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            selectedIgIndex = index; // Select the row that was right-clicked
            updateIgList();
            updateBuildOutputDisplay();
            updateButtonStates();
            showIgContextMenu(e);
        });

        const statusClass = getStatusClass(ig.buildStatus || 'Not Built');

        // Format git branch display
        let gitBranchDisplay = '';
        if (ig.gitBranch) {
            gitBranchDisplay = ig.gitBranch;
            // Add styling for common branches
            if (ig.gitBranch === 'main' || ig.gitBranch === 'master') {
                gitBranchDisplay = `<span style="color: #28a745; font-weight: 500;">${ig.gitBranch}</span>`;
            } else if (ig.gitBranch === 'develop' || ig.gitBranch === 'dev') {
                gitBranchDisplay = `<span style="color: #17a2b8; font-weight: 500;">${ig.gitBranch}</span>`;
            } else if (ig.gitBranch === 'detached') {
                gitBranchDisplay = `<span style="color: #ffc107; font-weight: 500;">detached HEAD</span>`;
            } else {
                gitBranchDisplay = `<span style="color: #6f42c1; font-weight: 500;">${ig.gitBranch}</span>`;
            }
        } else {
            gitBranchDisplay = '<span style="color: #6c757d;">-</span>';
        }

        const lastBuildDisplay = formatRelativeTime(ig.lastBuildStart);

        row.innerHTML = 
            '<td>' + ig.name + '</td>' +
            '<td>' + ig.version + '</td>' +
            '<td>' + gitBranchDisplay + '</td>' +
            '<td>' + ig.folder + '</td>' +
            '<td><span class="status-badge ' + statusClass + '">' + (ig.buildStatus || 'Not Built') + '</span></td>' +
            '<td>' + (ig.buildTime || '-') + '</td>' +
            '<td>' + (ig.builtSize || '-') + '</td>' +
          '<td>' + lastBuildDisplay + '</td>';
        
        igListBody.appendChild(row);
    }

    updateColumnHeaders();

    // Auto-select first item if none selected
    if (selectedIgIndex === -1 && igList.length > 0) {
        selectedIgIndex = 0;
        updateBuildOutputDisplay();
        updateButtonStates();
    }
}

function getStatusClass(status) {
    const statusMap = {
        'Success': 'status-success',
        'Error': 'status-error',
        'Building': 'status-building',
        'Publishing': 'status-publishing',
        'Not Built': 'status-none'
    };
    return statusMap[status] || 'status-none';
}

// Button state management
function updateButtonStates() {
    const ig = getSelectedIg();
    const hasSelection = ig !== null;
    const isBuilding = hasSelection && buildProcesses.has(selectedIgIndex);
    const isGitRepo = hasSelection && checkIfGitRepo(ig ? ig.folder : null);

    const canPublishToWebsite = hasSelection &&
      checkFileExists(ig ? ig.folder : null, 'output/qa.json') &&
      checkFileExists(ig ? ig.folder : null, 'publication-request.json');

    setButtonState('btn-delete', hasSelection);
    setButtonState('btn-build', hasSelection && !isBuilding);
    setButtonState('btn-stop', hasSelection && isBuilding);
    setButtonState('btn-open-ig', hasSelection && checkFileExists(ig ? ig.folder : null, 'output/index.html'));
    setButtonState('btn-open-qa', hasSelection && checkFileExists(ig ? ig.folder : null, 'output/qa.html'));
    setButtonState('btn-copy', hasSelection);
    setButtonState('btn-update', hasSelection && isGitRepo);
    setButtonState('btn-tools', hasSelection);
}

function setButtonState(buttonId, enabled) {
    const button = document.getElementById(buttonId);
    if (button) {
        button.disabled = !enabled;
    }
}

function checkFileExists(folder, relativePath) {
    if (!folder) return false;
    try {
        const fullPath = path.join(folder, relativePath);
        return fs.existsSync(fullPath);
    } catch (error) {
        return false;
    }
}

function checkIfGitRepo(folder) {
    if (!folder) return false;
    try {
        const gitPath = path.join(folder, '.git');
        return fs.existsSync(gitPath);
    } catch (error) {
        return false;
    }
}

function startFileWatcher() {
    fileWatcher = setInterval(function() {
        updateButtonStates();
    }, 5000);
}

async function addFolder() {
    try {
        const result = await ipcRenderer.invoke('select-folder');
        if (!result.canceled && result.filePaths.length > 0) {
            const folderPath = result.filePaths[0];
            await addIgFromFolder(folderPath);
        }
    } catch (error) {
        appendToBuildOutput('Error adding folder: ' + error.message);
    }
}

async function getPackageId(folder) {
    try {
        // Read ig.ini file
        const igIniPath = path.join(folder, 'ig.ini');
        if (!fs.existsSync(igIniPath)) {
            throw new Error('ig.ini not found');
        }

        const iniContent = fs.readFileSync(igIniPath, 'utf8');

        // Parse INI file to find ig= in [IG] section
        const lines = iniContent.split('\n');
        let inIGSection = false;
        let igResourcePath = null;

        for (const line of lines) {
            const trimmedLine = line.trim();

            if (trimmedLine === '[IG]') {
                inIGSection = true;
                continue;
            }

            if (trimmedLine.startsWith('[') && trimmedLine.endsWith(']')) {
                inIGSection = false;
                continue;
            }

            if (inIGSection && (trimmedLine.startsWith('ig=') || trimmedLine.startsWith('ig ='))) {
                if (trimmedLine.startsWith('ig=')) {
                    igResourcePath = trimmedLine.substring(3).trim();
                } else {
                    igResourcePath = trimmedLine.substring(4).trim();
                }
                break;
            }
        }

        if (!igResourcePath) {
            throw new Error('No ig= found in [IG] section');
        }

        // Read the IG resource file
        const igResourceFullPath = path.join(folder, igResourcePath);
        if (!fs.existsSync(igResourceFullPath)) {
            // IG resource file doesn't exist - try SUSHI config fallback
            return await getSushiConfigInfo(folder, igResourcePath);
        }
        const resourceContent = fs.readFileSync(igResourceFullPath, 'utf8');
        let igResource;

        // Try to parse as JSON first, then XML
        try {
            igResource = JSON.parse(resourceContent);
        } catch (jsonError) {
            // Try XML parsing
            try {
                igResource = parseXmlIgResource(resourceContent);
            } catch (xmlError) {
                throw new Error(`Failed to parse IG resource as JSON or XML. JSON error: ${jsonError.message}, XML error: ${xmlError.message}`);
            }
        }

        // Extract packageId and version from FHIR ImplementationGuide
        if (igResource.resourceType !== 'ImplementationGuide') {
            throw new Error('Resource is not an ImplementationGuide');
        }

        const packageId = igResource.packageId;
        const version = igResource.version;
        const title = igResource.title;

        if (!packageId) {
            throw new Error('No packageId found in ImplementationGuide');
        }

        const result = version ? `${packageId}#${version}` : packageId;

        return {
            packageId: packageId,
            version: version || 'Unknown',
            title: title || packageId,
            fullPackageId: result
        };

    } catch (error) {
        throw new Error(`Failed to get package ID: ${error.message}`);
    }
}

async function getSushiConfigInfo(folder, missingIgResourcePath) {
    const sushiConfigPath = path.join(folder, 'sushi-config.yaml');

    if (!fs.existsSync(sushiConfigPath)) {
        throw new Error(`IG resource file not found: ${missingIgResourcePath}, and no sushi-config.yaml fallback available`);
    }

    try {
        const YAML = require('yaml');
        const sushiContent = fs.readFileSync(sushiConfigPath, 'utf8');
        const sushiConfig = YAML.parse(sushiContent);

        if (!sushiConfig) {
            throw new Error('Failed to parse sushi-config.yaml');
        }

        // Extract id, version, and title from SUSHI config
        const packageId = sushiConfig.id;
        const version = sushiConfig.version;
        const title = sushiConfig.title || sushiConfig.name;

        if (!packageId) {
            throw new Error('No id found in sushi-config.yaml');
        }

        const result = version ? `${packageId}#${version}` : packageId;

        return {
            packageId: packageId,
            version: version || 'Unknown',
            title: title || packageId,
            fullPackageId: result,
            source: 'sushi-config.yaml' // Indicate the source for debugging
        };

    } catch (yamlError) {
        throw new Error(`Failed to parse sushi-config.yaml: ${yamlError.message}`);
    }
}

function parseXmlIgResource(xmlContent) {
    // Simple XML parsing for FHIR ImplementationGuide
    // This is a basic implementation - for production, consider using a proper XML parser

    const result = {
        resourceType: 'ImplementationGuide'
    };

    // Extract packageId
    const packageIdMatch = xmlContent.match(/<packageId[^>]*value="([^"]+)"/);
    if (packageIdMatch) {
        result.packageId = packageIdMatch[1];
    }

    // Extract version
    const versionMatch = xmlContent.match(/<version[^>]*value="([^"]+)"/);
    if (versionMatch) {
        result.version = versionMatch[1];
    }

    // Extract title
    const titleMatch = xmlContent.match(/<title[^>]*value="([^"]+)"/);
    if (titleMatch) {
        result.title = titleMatch[1];
    }

    // Alternative: extract from text content if attributes don't work
    if (!result.packageId) {
        const packageIdTextMatch = xmlContent.match(/<packageId[^>]*>([^<]+)<\/packageId>/);
        if (packageIdTextMatch) {
            result.packageId = packageIdTextMatch[1].trim();
        }
    }

    if (!result.version) {
        const versionTextMatch = xmlContent.match(/<version[^>]*>([^<]+)<\/version>/);
        if (versionTextMatch) {
            result.version = versionTextMatch[1].trim();
        }
    }

    if (!result.title) {
        const titleTextMatch = xmlContent.match(/<title[^>]*>([^<]+)<\/title>/);
        if (titleTextMatch) {
            result.title = titleTextMatch[1].trim();
        }
    }

    return result;
}

async function addIgFromFolder(folderPath) {
    try {
        let igName = path.basename(folderPath);
        let version = 'Unknown';
        let gitBranch = await getCurrentGitBranch(folderPath);

        // Try to get proper name and version from IG resource
        try {
            const packageInfo = await getPackageId(folderPath);
            igName = packageInfo.packageId;
            version = packageInfo.version;
        } catch (error) {
            // Fallback to reading ig.ini directly
            appendToBuildOutput(`Could not read IG resource (${error.message}), using fallback method`);

            const igIniPath = path.join(folderPath, 'ig.ini');
            if (fs.existsSync(igIniPath)) {
                const iniContent = fs.readFileSync(igIniPath, 'utf8');
                const nameMatch = iniContent.match(/title\s*=\s*(.+)/);
                const versionMatch = iniContent.match(/version\s*=\s*(.+)/);

                if (nameMatch) igName = nameMatch[1].trim();
                if (versionMatch) version = versionMatch[1].trim();
            }
        }

        const newIg = {
            name: igName,
            version: version,
            folder: folderPath,
            gitBranch: gitBranch,
            buildStatus: 'Not Built',
            buildTime: '-',
            builtSize: '-',
            console: ''
        };

        igList.push(newIg);
        updateIgList();
        saveIgList();
    } catch (error) {
        appendToBuildOutput('Error adding IG: ' + error.message);
    }
}


async function deleteIg() {
    const ig = getSelectedIg();
    if (!ig) return;

    const choice = await showDeleteDialog(ig.name, ig.folder);

    if (choice === 'cancel') {
        return;
    }

    if (choice === 'delete-folder') {
        // Delete the folder from disk AND remove from list
        try {
            await ipcRenderer.invoke('delete-folder', ig.folder);

            // Remove from list
            igList.splice(selectedIgIndex, 1);
            selectedIgIndex = Math.max(0, Math.min(selectedIgIndex, igList.length - 1));
            updateIgList();
            saveIgList();
            updateButtonStates();

        } catch (error) {
            appendToBuildOutput('✗ Failed to delete folder: ' + error.message);
        }
    } else if (choice === 'remove-only') {
        // Just remove from list (original behavior)
        igList.splice(selectedIgIndex, 1);
        selectedIgIndex = Math.max(0, Math.min(selectedIgIndex, igList.length - 1));
        updateIgList();
        saveIgList();
        updateButtonStates();
    }
}

function showDeleteDialog(igName, folderPath) {
    return new Promise(function(resolve) {
        const dialog = document.createElement('div');
        dialog.innerHTML =
          '<div class="dialog-overlay">' +
          '<div class="dialog">' +
          '<div class="dialog-header">Delete "' + igName + '"</div>' +
          '<div class="dialog-content">' +
          '<p>What would you like to do?</p>' +
          '<div class="folder-info">' +
          '<strong>Folder:</strong> ' + folderPath +
          '</div>' +
          '<div class="warning-text">' +
          '⚠️ Deleting the folder will permanently remove all files and cannot be undone!' +
          '</div>' +
          '</div>' +
          '<div class="dialog-buttons">' +
          '<button onclick="resolveDeleteDialog(\'cancel\')" class="btn-cancel">Cancel</button>' +
          '<button onclick="resolveDeleteDialog(\'remove-only\')" class="btn-cancel">Remove from List Only</button>' +
          '<button onclick="resolveDeleteDialog(\'delete-folder\')" class="btn-delete">Delete Folder from Disk</button>' +
          '</div>' +
          '</div>' +
          '</div>';

        // Add resolver function to window
        window.resolveDeleteDialog = function(value) {
            document.body.removeChild(dialog);
            delete window.resolveDeleteDialog;
            resolve(value);
        };

        document.body.appendChild(dialog);
    });
}

function buildIg() {
    const ig = getSelectedIg();
    if (!ig) return;
    
    // Check if this IG is already building
    if (buildProcesses.has(selectedIgIndex)) {
        appendToBuildOutput('Build already in progress for ' + ig.name);
        return;
    }

    ig.lastBuildStart = Date.now();

    resetIgConsole(ig, 'IG Publisher Build');
    appendToIgConsole(ig, 'Starting build for ' + ig.name);
    ig.buildStatus = 'Building';
    updateIgList();
    updateButtonStates();
    
    // Start the actual IG Publisher build
    startIgPublisherBuild(ig);
}

async function startIgPublisherBuild(ig) {
    try {
        const settings = getCurrentSettings();
        let version = settings.igPublisherVersion;
        let downloadUrl = null;
        
        // Get download URL for the selected version
        if (version === 'latest') {
            // Use the first version from our loaded versions, or fallback
            const savedVersions = loadSavedPublisherVersions();
            if (savedVersions && savedVersions.length > 0) {
                version = savedVersions[0].version;
                downloadUrl = savedVersions[0].url;
                appendToIgConsole(ig, 'Using latest version: ' + version);
            } else {
                throw new Error('No publisher versions available. Please check internet connection.');
            }
        } else {
            // Find the download URL for the specific version
            const savedVersions = loadSavedPublisherVersions();
            if (savedVersions) {
                for (let i = 0; i < savedVersions.length; i++) {
                    if (savedVersions[i].version === version) {
                        downloadUrl = savedVersions[i].url;
                        break;
                    }
                }
            }
            
            if (!downloadUrl) {
                throw new Error('Download URL not found for version ' + version);
            }
        }
        
        appendToIgConsole(ig, 'IG Publisher version: ' + version);
        appendToIgConsole(ig, 'Memory limit: ' + settings.maxMemory + 'GB');
        
        // Ensure JAR exists (download if necessary)
        const jarPath = await ensureJarExists(version, downloadUrl, ig);
        
        // Build command
        const command = buildIgPublisherCommand(ig, jarPath);
        appendToIgConsole(ig, 'Command: ' + command.join(' '));
        
        // Start the Java process
        const buildProcess = await runIgPublisherProcess(ig, command);
        
        // Store the process for stopping if needed
        buildProcesses.set(selectedIgIndex, buildProcess);
        
    } catch (error) {
        appendToIgConsole(ig, 'Build setup failed: ' + error.message);
        ig.buildStatus = 'Error';
        updateIgList();
        updateButtonStates();
    }
}


function stripAnsiCodes(text) {
    // ANSI escape sequence regex - matches control characters like [0;39m, [32m, etc.
    const ansiRegex = /\x1b\[[0-9;]*[mGKHF]/g;
    return text.replace(ansiRegex, '');
}

function runIgPublisherProcess(ig, command) {
    return new Promise(function(resolve, reject) {
        const spawn = require('child_process').spawn;

        appendToIgConsole(ig, 'Starting IG Publisher process...');

        const javaProcess = spawn(command[0], command.slice(1), {
            cwd: ig.folder,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let hasOutput = false;
        let wasTerminated = false;
        const startTime = Date.now();

        // Create the process control object that we'll return
        const processControl = {
            kill: function() {
                wasTerminated = true;
                try {
                    // Try graceful termination first
                    javaProcess.kill('SIGTERM');

                    // If it doesn't respond in 5 seconds, force kill
                    setTimeout(function() {
                        if (!javaProcess.killed) {
                            appendToIgConsole(ig, 'Process not responding, forcing termination...');
                            javaProcess.kill('SIGKILL');
                        }
                    }, 5000);

                } catch (error) {
                    appendToIgConsole(ig, 'Error terminating process: ' + error.message);
                }
            },
            pid: javaProcess.pid
        };

        javaProcess.stdout.on('data', function(data) {
            hasOutput = true;
            const text = data.toString();
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].trim()) {
                    const cleanLine = stripAnsiCodes(lines[i].trim());
                    appendToIgConsole(ig, cleanLine);
                }
            }
        });

        javaProcess.stderr.on('data', function(data) {
            hasOutput = true;
            const text = data.toString();
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].trim()) {
                    const cleanLine = stripAnsiCodes(lines[i].trim());
                    appendToIgConsole(ig, cleanLine);
                }
            }
        });

        javaProcess.on('close', function(code, signal) {
            const endTime = Date.now();
            const duration = Math.round((endTime - startTime) / 1000);
            const minutes = Math.floor(duration / 60);
            const seconds = duration % 60;
            const timeString = minutes + ':' + seconds.toString().padStart(2, '0');

            // Remove from tracking when process ends
            buildProcesses.delete(selectedIgIndex);

            if (wasTerminated) {
                ig.buildStatus = 'Stopped';
                ig.buildTime = timeString;
                appendToIgConsole(ig, '⏹ Build terminated by user after ' + timeString);
            } else if (code === 0) {
                ig.buildStatus = 'Success';
                ig.buildTime = timeString;

                // Try to get output size
                try {
                    const outputPath = path.join(ig.folder, 'output');
                    if (fs.existsSync(outputPath)) {
                        const stats = getDirectorySize(outputPath);
                        ig.builtSize = (stats / 1024 / 1024).toFixed(1) + ' MB';
                    }
                } catch (error) {
                    ig.builtSize = 'Unknown';
                }

                appendToIgConsole(ig, '✓ Build completed successfully');
                appendToIgConsole(ig, 'Build time: ' + timeString);
                appendToIgConsole(ig, 'Output size: ' + ig.builtSize);
            } else {
                ig.buildStatus = 'Error';
                ig.buildTime = timeString;
                const exitReason = signal ? ` (signal: ${signal})` : ` (exit code: ${code})`;
                appendToIgConsole(ig, '✗ Build failed' + exitReason);
                appendToIgConsole(ig, 'Build time: ' + timeString);
            }

            updateIgList();
            updateButtonStates();
            saveIgList();
        });

        javaProcess.on('error', function(error) {
            buildProcesses.delete(selectedIgIndex);
            ig.buildStatus = 'Error';

            if (error.code === 'ENOENT') {
                appendToIgConsole(ig, '✗ Java not found. Please install Java and ensure it\'s in your PATH.');
            } else {
                appendToIgConsole(ig, '✗ Process error: ' + error.message);
            }

            updateIgList();
            updateButtonStates();
            reject(error);
        });

        // Return the process control object immediately
        resolve(processControl);
    });
}

function getDirectorySize(dirPath) {
    let totalSize = 0;
    
    function calculateSize(currentPath) {
        const stats = fs.statSync(currentPath);
        if (stats.isFile()) {
            totalSize += stats.size;
        } else if (stats.isDirectory()) {
            const files = fs.readdirSync(currentPath);
            for (let i = 0; i < files.length; i++) {
                calculateSize(path.join(currentPath, files[i]));
            }
        }
    }
    
    try {
        calculateSize(dirPath);
    } catch (error) {
        // Ignore errors (permission issues, etc.)
    }
    
    return totalSize;
}

function stopBuild() {
    const ig = getSelectedIg();
    if (!ig || !buildProcesses.has(selectedIgIndex)) {
        return;
    }

    appendToBuildOutput('Stopping build for ' + ig.name + '...');

    // Get the process object and kill it
    const buildProcess = buildProcesses.get(selectedIgIndex);
    if (buildProcess && buildProcess.kill) {
        try {
            buildProcess.kill();
            appendToIgConsole(ig, 'Build process terminated by user');
        } catch (error) {
            appendToIgConsole(ig, 'Error stopping process: ' + error.message);
        }
    }

    // Remove from tracking map
    buildProcesses.delete(selectedIgIndex);

    // Update UI
    ig.buildStatus = 'Stopped';
    updateIgList();
    updateButtonStates();

}

async function openIG() {
    const ig = getSelectedIg();
    if (!ig) return;

    const indexPath = path.join(ig.folder, 'output', 'index.html');

    try {
        if (fs.existsSync(indexPath)) {
            // Use proper file URL format
            const fileUrl = 'file://' + indexPath.replace(/\\/g, '/');
            appendToBuildOutput('Opening IG: ' + fileUrl);
            await ipcRenderer.invoke('open-external', fileUrl);
        } else {
            appendToBuildOutput('Build output not found: ' + indexPath);
            appendToBuildOutput('Build the IG first to generate output files');
        }
    } catch (error) {
        appendToBuildOutput('Failed to open IG: ' + error.message);
    }
}

async function openQA() {
    const ig = getSelectedIg();
    if (!ig) return;

    const qaPath = path.join(ig.folder, 'output', 'qa.html');

    try {
        if (fs.existsSync(qaPath)) {
            // Use proper file URL format
            const fileUrl = 'file://' + qaPath.replace(/\\/g, '/');
            appendToBuildOutput('Opening QA: ' + fileUrl);
            await ipcRenderer.invoke('open-external', fileUrl);
        } else {
            appendToBuildOutput('QA report not found: ' + qaPath);
            appendToBuildOutput('Build the IG first to generate QA report');
        }
    } catch (error) {
        appendToBuildOutput('Failed to open QA: ' + error.message);
    }
}

async function updateSource() {
    const ig = getSelectedIg();
    
    if (!ig) {
        return;
    }
    
    if (!checkIfGitRepo(ig.folder)) {
        appendToBuildOutput('This IG is not a git repository');
        return;
    }

    // Use proper dialog instead of prompt()
    const choice = await showUpdateDialog(ig.name);
    
    if (choice && choice !== 'cancel') {
        performGitUpdate(ig, choice);
    } else {
    }
}

function showUpdateDialog(igName) {
    return new Promise(function(resolve) {
        const dialog = document.createElement('div');
        dialog.innerHTML = 
            '<div class="dialog-overlay">' +
                '<div class="dialog">' +
                    '<div class="dialog-header">Update "' + igName + '"</div>' +
                    '<div class="dialog-content">' +
                        '<p>How would you like to update the source?</p>' +
                    '</div>' +
                    '<div class="dialog-buttons">' +
                        '<button onclick="resolveUpdateDialog(\'cancel\')" class="btn-cancel">Cancel</button>' +
                        '<button onclick="resolveUpdateDialog(\'pull-only\')" class="btn-cancel">Just Pull</button>' +
                        '<button onclick="resolveUpdateDialog(\'reset-pull\')" class="btn-cancel">Reset & Pull</button>' +
                        '<button onclick="resolveUpdateDialog(\'stash-pull-pop\')" class="btn-ok">Stash, Pull, Pop</button>' +
                    '</div>' +
                '</div>' +
            '</div>';
        
        // Add resolver function to window
        window.resolveUpdateDialog = function(value) {
            document.body.removeChild(dialog);
            delete window.resolveUpdateDialog;
            resolve(value);
        };
        
        document.body.appendChild(dialog);
    });
}

// Git operations
async function performGitUpdate(ig, operation) {
    resetIgConsole(ig, 'Git Update');
    appendToIgConsole(ig, '*** WORKING GIT VERSION ***');
    appendToIgConsole(ig, 'Updating ' + ig.name + ' (' + operation + ')');
    
    try {
        switch (operation) {
            case 'stash-pull-pop':
                appendToIgConsole(ig, '>>> STEP 1: Stashing changes');
                await runGitCommand(ig, ['stash']);
                appendToIgConsole(ig, '>>> STEP 2: Pulling latest changes');
                await runGitCommand(ig, ['pull']);
                appendToIgConsole(ig, '>>> STEP 3: Restoring stashed changes');
                await runGitCommand(ig, ['stash', 'pop']);
                break;
            case 'reset-pull':
                appendToIgConsole(ig, '>>> STEP 1: Resetting to HEAD');
                await runGitCommand(ig, ['reset', '--hard', 'HEAD']);
                appendToIgConsole(ig, '>>> STEP 2: Pulling latest changes');
                await runGitCommand(ig, ['pull']);
                break;
            case 'pull-only':
                appendToIgConsole(ig, '>>> STEP 1: Pulling latest changes');
                await runGitCommand(ig, ['pull']);
                break;
        }
        
        appendToIgConsole(ig, 'All git operations completed successfully');
        
    } catch (error) {
        appendToIgConsole(ig, 'Git update failed: ' + error.message);
    }
}

function runGitCommand(ig, args) {
    return new Promise(function(resolve, reject) {
        const spawn = require('child_process').spawn;
        
        appendToIgConsole(ig, '> git ' + args.join(' '));
        
        const git = spawn('git', args, { 
            cwd: ig.folder,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let hasOutput = false;
        
        git.stdout.on('data', function(data) {
            hasOutput = true;
            const text = data.toString();
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].trim()) {
                    appendToIgConsole(ig, '  ' + lines[i].trim());
                }
            }
        });
        
        git.stderr.on('data', function(data) {
            hasOutput = true;
            const text = data.toString();
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].trim()) {
                    appendToIgConsole(ig, '  ' + lines[i].trim());
                }
            }
        });
        
        git.on('close', function(code) {
            if (code !== 0) {
                const errorMsg = 'Command failed with exit code ' + code;
                appendToIgConsole(ig, errorMsg);
                reject(new Error(errorMsg));
            } else {
                if (!hasOutput) {
                    appendToIgConsole(ig, '  (no output)');
                }
                appendToIgConsole(ig, '✓ Command completed');
                resolve();
            }
        });
        
        git.on('error', function(error) {
            appendToIgConsole(ig, 'Git error: ' + error.message);
            reject(error);
        });
    });
}

// Copy menu
function showCopyMenu(event) {
    const ig = getSelectedIg();
    if (!ig) return;

    buildCopyMenuItems(ig).then(function(menuItems) {
        const menu = document.getElementById('copy-menu');
        menu.innerHTML = '';

        for (let i = 0; i < menuItems.length; i++) {
            const item = menuItems[i];
            const menuItem = document.createElement('div');
            menuItem.className = 'context-menu-item';
            menuItem.innerHTML = `<span class="menu-icon">${item.icon}</span>${item.label}`;
            menuItem.addEventListener('click', function() {
                handleCopyAction(item.action, item.value);
                closeContextMenus();
            });
            menu.appendChild(menuItem);
        }

        const rect = event.target.getBoundingClientRect();
        menu.style.display = 'block';
        menu.style.left = rect.left + 'px';
        menu.style.top = (rect.bottom + 5) + 'px';

        event.stopPropagation();
    });
}

async function buildCopyMenuItems(ig) {
    const items = [];

    items.push({
        action: 'copy-folder-path',
        label: 'Folder Path',
        value: ig.folder,
        icon: '📁'
    });

    // Try to get package ID
    try {
        const packageInfo = await getPackageId(ig.folder);
        items.push({
            action: 'copy-package-id',
            label: 'Package ID',
            value: packageInfo.fullPackageId
        });
    } catch (error) {
        // Package ID not available
        appendToBuildOutput('Package ID not available: ' + error.message);
    }

    try {
        const gitUrl = await getGitRemoteUrl(ig.folder);
        if (gitUrl) {
            items.push({
                action: 'copy-github-url',
                label: 'GitHub Repository URL',
                value: gitUrl
            });
        }
    } catch (error) {
        // Skip git URL if not available
    }

    initializeIgConsole(ig);
    items.push({
        action: 'copy-build-log',
        label: 'Last Build Log',
        value: ig.console
    });

    const jekyllCommand = 'cd "' + path.join(ig.folder, 'temp', 'pages') + '" && jekyll build --destination "' + path.join(ig.folder, 'output') + '"';
    items.push({
        action: 'copy-jekyll-command',
        label: 'Jekyll Command',
        value: jekyllCommand
    });

    return items;
}

async function getGitRemoteUrl(folder) {
    return new Promise(function(resolve, reject) {
        if (!fs.existsSync(path.join(folder, '.git'))) {
            reject(new Error('Not a git repository'));
            return;
        }
        
        const spawn = require('child_process').spawn;
        const git = spawn('git', ['remote', '-v'], { 
            cwd: folder,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let output = '';
        
        git.stdout.on('data', function(data) {
            output += data.toString();
        });
        
        git.on('close', function(code) {
            if (code !== 0) {
                reject(new Error('Git command failed'));
                return;
            }
            
            const lines = output.split('\n');
            const fetchLines = [];
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes('(fetch)')) {
                    fetchLines.push(lines[i]);
                }
            }
            
            if (fetchLines.length === 0) {
                reject(new Error('No fetch remote found'));
                return;
            }
            
            const match = fetchLines[0].match(/\s+(.+?)\s+\(fetch\)/);
            if (match && match[1]) {
                let url = match[1];
                if (url.startsWith('git@github.com:')) {
                    url = url.replace('git@github.com:', 'https://github.com/');
                }
                if (url.endsWith('.git')) {
                    url = url.slice(0, -4);
                }
                resolve(url);
            } else {
                reject(new Error('Could not parse remote URL'));
            }
        });
        
        git.on('error', function(error) {
            reject(error);
        });
    });
}

function handleCopyAction(action, value) {
    if (!value) {
        return;
    }
    
    navigator.clipboard.writeText(value).then(function() {
        const actionName = action.replace('copy-', '').replace('-', ' ');
    }).catch(function(err) {
        appendToBuildOutput('Failed to copy to clipboard: ' + err.message);
    });
}

function showToolsMenu(event) {
    const menu = document.getElementById('tools-menu');
    const rect = event.target.getBoundingClientRect();
    
    menu.style.display = 'block';
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.bottom + 5) + 'px';
    
    event.stopPropagation();
}

async function handleToolsAction(action) {
    const ig = getSelectedIg();
    if (!ig) {
        return;
    }

    switch (action) {
        case 'clear-txcache':
            await clearTxCache(ig);
            break;
        case 'open-folder':
            await openFolder(ig);
            break;
        case 'open-terminal':
            await openTerminal(ig);
            break;
        case 'run-jekyll':
            await runJekyll(ig);
            break;
        case 'open-settings':
            await openSettingsFile();
            break;
        case 'publish-to-website':
            await showPublishToWebsiteDialog(ig);
            break;
    }
}

async function clearTxCache(ig) {
    const txCachePath = path.join(ig.folder, 'input-cache', 'txcache');

    try {

        if (!fs.existsSync(txCachePath)) {
            appendToBuildOutput('TxCache folder not found: ' + txCachePath);
            return;
        }

        // Delete all contents of txcache folder
        const files = fs.readdirSync(txCachePath);
        let deletedCount = 0;

        for (const file of files) {
            const filePath = path.join(txCachePath, file);
            const stats = fs.statSync(filePath);

            if (stats.isDirectory()) {
                await ipcRenderer.invoke('delete-folder', filePath);
            } else {
                fs.unlinkSync(filePath);
            }
            deletedCount++;
        }

        appendToBuildOutput('✓ Cleared ' + deletedCount + ' items from TxCache');

    } catch (error) {
        appendToBuildOutput('✗ Failed to clear TxCache: ' + error.message);
    }
}

async function openFolder(ig) {
    try {
        await ipcRenderer.invoke('show-item-in-folder', ig.folder);
    } catch (error) {
        appendToBuildOutput('✗ Failed to open folder: ' + error.message);
    }
}

async function openTerminal(ig) {
    try {
        await ipcRenderer.invoke('open-terminal', ig.folder);
    } catch (error) {
        appendToBuildOutput('✗ Failed to open terminal: ' + error.message);
    }
}

async function runJekyll(ig) {
    // Check if Jekyll is already running for this IG
    if (buildProcesses.has(selectedIgIndex)) {
        appendToBuildOutput('Another process is already running for ' + ig.name);
        return;
    }

    try {
        const pagesPath = path.join(ig.folder, 'temp', 'pages');
        const outputPath = path.join(ig.folder, 'output');

        if (!fs.existsSync(pagesPath)) {
            appendToBuildOutput('✗ Jekyll source folder not found: ' + pagesPath);
            appendToBuildOutput('Build the IG first to generate Jekyll pages');
            return;
        }

        resetIgConsole(ig, 'Jekyll Build');
        appendToIgConsole(ig, 'Starting Jekyll build...');
        appendToIgConsole(ig, 'Source: ' + pagesPath);
        appendToIgConsole(ig, 'Destination: ' + outputPath);

        ig.buildStatus = 'Building';
        updateIgList();
        updateButtonStates();

        const jekyllProcess = await runJekyllProcess(ig, pagesPath, outputPath);
        buildProcesses.set(selectedIgIndex, jekyllProcess);

    } catch (error) {
        appendToIgConsole(ig, '✗ Jekyll setup failed: ' + error.message);
        ig.buildStatus = 'Error';
        updateIgList();
        updateButtonStates();
    }
}

// Jekyll process runner
function runJekyllProcess(ig, sourcePath, outputPath) {
    return new Promise(function(resolve, reject) {
        const spawn = require('child_process').spawn;

        appendToIgConsole(ig, '> jekyll build --source "' + sourcePath + '" --destination "' + outputPath + '"');

        const jekyll = spawn('jekyll', ['build', '--source', sourcePath, '--destination', outputPath], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let hasOutput = false;
        let wasTerminated = false;
        const startTime = Date.now();

        // Create the process control object
        const processControl = {
            kill: function() {
                wasTerminated = true;
                try {
                    jekyll.kill('SIGTERM');
                    setTimeout(function() {
                        if (!jekyll.killed) {
                            jekyll.kill('SIGKILL');
                        }
                    }, 5000);
                } catch (error) {
                    appendToIgConsole(ig, 'Error terminating Jekyll: ' + error.message);
                }
            },
            pid: jekyll.pid
        };

        jekyll.stdout.on('data', function(data) {
            hasOutput = true;
            const text = data.toString();
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].trim()) {
                    const cleanLine = stripAnsiCodes(lines[i].trim());
                    appendToIgConsole(ig, cleanLine);
                }
            }
        });

        jekyll.stderr.on('data', function(data) {
            hasOutput = true;
            const text = data.toString();
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].trim()) {
                    const cleanLine = stripAnsiCodes(lines[i].trim());
                    appendToIgConsole(ig, cleanLine);
                }
            }
        });

        jekyll.on('close', function(code, signal) {
            const endTime = Date.now();
            const duration = Math.round((endTime - startTime) / 1000);
            const timeString = Math.floor(duration / 60) + ':' + (duration % 60).toString().padStart(2, '0');

            buildProcesses.delete(selectedIgIndex);

            if (wasTerminated) {
                ig.buildStatus = 'Stopped';
                appendToIgConsole(ig, '⏹ Jekyll build terminated by user after ' + timeString);
            } else if (code === 0) {
                ig.buildStatus = 'Success';
                appendToIgConsole(ig, '✓ Jekyll build completed successfully');
                appendToIgConsole(ig, 'Build time: ' + timeString);
            } else {
                ig.buildStatus = 'Error';
                const exitReason = signal ? ` (signal: ${signal})` : ` (exit code: ${code})`;
                appendToIgConsole(ig, '✗ Jekyll build failed' + exitReason);
                appendToIgConsole(ig, 'Build time: ' + timeString);
            }

            updateIgList();
            updateButtonStates();
            saveIgList();
        });

        jekyll.on('error', function(error) {
            buildProcesses.delete(selectedIgIndex);
            ig.buildStatus = 'Error';

            if (error.code === 'ENOENT') {
                appendToIgConsole(ig, '✗ Jekyll not found. Please install Jekyll and ensure it\'s in your PATH.');
                appendToIgConsole(ig, 'Install with: gem install jekyll bundler');
            } else {
                appendToIgConsole(ig, '✗ Jekyll error: ' + error.message);
            }

            updateIgList();
            updateButtonStates();
            reject(error);
        });

        resolve(processControl);
    });
}

// Open settings file implementation
async function openSettingsFile() {
    try {
        const settingsPath = await ipcRenderer.invoke('get-fhir-settings-path');

        // Check if file exists, create if it doesn't
        if (!fs.existsSync(settingsPath)) {
            const settingsDir = path.dirname(settingsPath);
            if (!fs.existsSync(settingsDir)) {
                fs.mkdirSync(settingsDir, { recursive: true });
            }

            // Create default settings file
            const defaultSettings = {
                "resourceType": "Parameters",
                "parameter": [
                    {
                        "name": "system-level",
                        "valueBoolean": true
                    }
                ]
            };

            fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2));
        }

        await ipcRenderer.invoke('open-external', 'file://' + settingsPath);

    } catch (error) {
        appendToBuildOutput('✗ Failed to open settings file: ' + error.message);
    }
}

function closeContextMenus() {
    const copyMenu = document.getElementById('copy-menu');
    const toolsMenu = document.getElementById('tools-menu');
    if (copyMenu) copyMenu.style.display = 'none';
    if (toolsMenu) toolsMenu.style.display = 'none';
}

function toggleOptionsPanel() {
    optionsPanelVisible = !optionsPanelVisible;
    
    if (optionsPanelVisible) {
        optionsPanel.classList.add('visible');
        toggleButton.classList.add('expanded');
    } else {
        optionsPanel.classList.remove('visible');
        toggleButton.classList.remove('expanded');
    }
}

function saveIgList() {
    try {
        const igListToSave = [];
        for (let i = 0; i < igList.length; i++) {
            const ig = igList[i];
            const savedIg = {
                name: ig.name,
                version: ig.version,
                folder: ig.folder,
                gitBranch: ig.gitBranch,
                buildStatus: ig.buildStatus,
                buildTime: ig.buildTime,
                builtSize: ig.builtSize,
                lastBuildStart: ig.lastBuildStart
                // Don't save console data
            };
            igListToSave.push(savedIg);
        }
        localStorage.setItem('igList', JSON.stringify(igListToSave));
    } catch (error) {
        console.log('Could not save IG list:', error);
    }
}

function loadIgList() {
    try {
        const saved = localStorage.getItem('igList');
        if (saved) {
            igList = JSON.parse(saved);
            for (let i = 0; i < igList.length; i++) {
                const ig = igList[i];
                initializeIgConsole(ig);

                // Backwards compatibility - if gitBranch is not set, try to get it
                if (ig.gitBranch === undefined) {
                    getCurrentGitBranch(ig.folder).then(function(branch) {
                        ig.gitBranch = branch;
                        updateIgList(); // Refresh display
                    });
                }
            }
        }
    } catch (error) {
        console.log('Could not load IG list:', error);
        igList = [];
    }
}

// Publisher version management
async function loadPublisherVersions() {
    console.log('loadPublisherVersions function started');
    appendToBuildOutput('Loading IG Publisher versions...');

    try {
        // Create abort controller with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(function() {
            controller.abort();
        }, 10000); // 10 second timeout

        const response = await fetch('https://api.github.com/repos/HL7/fhir-ig-publisher/releases', {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'IG-Publisher-Manager'
            },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error('GitHub API responded with ' + response.status + ': ' + response.statusText);
        }

        const releases = await response.json();
        const versions = [];

        // Process each release
        for (let i = 0; i < releases.length; i++) {
            const release = releases[i];
            if (release.tag_name && release.assets && release.assets.length > 0) {
                // Look for publisher.jar specifically
                const publisherAsset = release.assets.find(asset =>
                  asset.name === 'publisher.jar' || asset.name.includes('publisher')
                );

                if (publisherAsset) {
                    versions.push({
                        version: release.tag_name,
                        url: publisherAsset.browser_download_url,
                        directUrl: `https://github.com/HL7/fhir-ig-publisher/releases/download/${release.tag_name}/publisher.jar`
                    });
                }
            }
        }

        if (versions.length > 0) {
            updatePublisherVersionDropdown(versions);
            savePublisherVersions(versions);
            appendToBuildOutput('Loaded ' + versions.length + ' IG Publisher versions');
        } else {
            throw new Error('No valid releases found');
        }

    } catch (error) {
        console.log('Error in loadPublisherVersions:', error);
        let errorMessage = 'Unknown error';

        if (error.name === 'AbortError') {
            errorMessage = 'Request timed out after 10 seconds';
        } else if (error.message) {
            errorMessage = error.message;
        }

        appendToBuildOutput('Failed to load publisher versions: ' + errorMessage);

        // Try to load from saved versions
        const savedVersions = loadSavedPublisherVersions();
        if (savedVersions && savedVersions.length > 0) {
            updatePublisherVersionDropdown(savedVersions);
            appendToBuildOutput('Using ' + savedVersions.length + ' cached publisher versions');
        } else {
            appendToBuildOutput('No cached versions available');
            // Add fallback version
            const fallbackVersions = [{
                version: 'latest',
                url: 'https://github.com/HL7/fhir-ig-publisher/releases/latest/download/publisher.jar',
                directUrl: 'https://github.com/HL7/fhir-ig-publisher/releases/latest/download/publisher.jar'
            }];
            updatePublisherVersionDropdown(fallbackVersions);
            savePublisherVersions(fallbackVersions);
            appendToBuildOutput('Using fallback version configuration');
        }
    }
}

function updatePublisherVersionDropdown(versions) {
    try {
        const dropdown = document.getElementById('ig-publisher-version');
        if (!dropdown) {
            return;
        }
        
        // Clear existing options except "Latest"
        dropdown.innerHTML = '<option value="latest">Latest</option>';
        
        // Add version options
        for (let i = 0; i < versions.length; i++) {
            const versionInfo = versions[i];
            const option = document.createElement('option');
            option.value = versionInfo.version;
            option.textContent = versionInfo.version;
            option.dataset.downloadUrl = versionInfo.url;
            dropdown.appendChild(option);
        }
        
    } catch (error) {
        console.log('Error updating publisher dropdown:', error);
    }
}

function savePublisherVersions(versions) {
    try {
        localStorage.setItem('igPublisherVersions', JSON.stringify(versions));
    } catch (error) {
        console.log('Failed to save publisher versions:', error);
    }
}

function loadSavedPublisherVersions() {
    try {
        const saved = localStorage.getItem('igPublisherVersions');
        if (saved) {
            return JSON.parse(saved);
        }
    } catch (error) {
        console.log('Failed to load saved publisher versions:', error);
    }
    return null;
}


// GitHub dialog and functionality
async function addFromGitHub() {
    // Try to auto-populate from clipboard when dialog opens
    let clipboardData = null;
    try {
        const clipboardText = await navigator.clipboard.readText();
        clipboardData = parseGitHubUrl(clipboardText, false); // false = don't show errors
    } catch (error) {
        // Clipboard access failed or parsing failed - that's okay
    }

    const result = await showGitHubDialog(clipboardData);

    if (result && result !== 'cancel') {
        await cloneGitHubRepository(result);
    }
}

function showGitHubDialog(initialData) {
    return new Promise(function(resolve) {
        // Get saved base folder
        const savedBaseFolder = localStorage.getItem('githubBaseFolder') || '';

        const dialog = document.createElement('div');
        dialog.innerHTML =
          '<div class="dialog-overlay">' +
          '<div class="dialog">' +
          '<div class="dialog-header">Add Implementation Guide from GitHub</div>' +
          '<div class="dialog-content">' +
          '<div class="paste-section">' +
          '<button id="paste-btn" class="btn-paste">Paste from Clipboard</button>' +
          '<div id="paste-error" class="paste-error" style="display: none;"></div>' +
          '</div>' +
          '<div class="form-group">' +
          '<label for="base-folder">Base Folder</label>' +
          '<div style="display: flex; gap: 8px;">' +
          '<input type="text" id="base-folder" value="' + savedBaseFolder + '" placeholder="Choose base folder for clones">' +
          '<button type="button" id="browse-base-folder">Browse...</button>' +
          '</div>' +
          '</div>' +
          '<div class="form-group">' +
          '<label for="git-org">Organization</label>' +
          '<input type="text" id="git-org" value="' + (initialData?.org || '') + '" placeholder="e.g., HL7">' +
          '</div>' +
          '<div class="form-group">' +
          '<label for="git-repo">Repository Name</label>' +
          '<input type="text" id="git-repo" value="' + (initialData?.repo || '') + '" placeholder="e.g., fhir-us-core">' +
          '</div>' +
          '<div class="form-group">' +
          '<label for="git-branch">Branch</label>' +
          '<input type="text" id="git-branch" value="' + (initialData?.branch || 'main') + '" placeholder="main">' +
          '</div>' +
          '</div>' +
          '<div class="dialog-buttons">' +
          '<button onclick="resolveGitHubDialog(\'cancel\')" class="btn-cancel">Cancel</button>' +
          '<button onclick="resolveGitHubDialog(\'ok\')" class="btn-ok">Clone Repository</button>' +
          '</div>' +
          '</div>' +
          '</div>';

        // Add resolver function to window
        window.resolveGitHubDialog = function(action) {
            if (action === 'ok') {
                const baseFolder = document.getElementById('base-folder').value.trim();
                const org = document.getElementById('git-org').value.trim();
                const repo = document.getElementById('git-repo').value.trim();
                const branch = document.getElementById('git-branch').value.trim();

                if (!baseFolder || !org || !repo || !branch) {
                    alert('Please fill in all fields');
                    return;
                }

                // Save base folder for next time
                localStorage.setItem('githubBaseFolder', baseFolder);

                document.body.removeChild(dialog);
                delete window.resolveGitHubDialog;
                resolve({
                    baseFolder: baseFolder,
                    org: org,
                    repo: repo,
                    branch: branch
                });
            } else {
                document.body.removeChild(dialog);
                delete window.resolveGitHubDialog;
                resolve('cancel');
            }
        };

        document.body.appendChild(dialog);

        // Set up event listeners for the dialog
        setupGitHubDialogListeners(dialog);
    });
}

function setupGitHubDialogListeners(dialog) {
    // Paste button
    const pasteBtn = dialog.querySelector('#paste-btn');
    const pasteError = dialog.querySelector('#paste-error');

    pasteBtn.addEventListener('click', async function() {
        try {
            const clipboardText = await navigator.clipboard.readText();
            const parsed = parseGitHubUrl(clipboardText, true); // true = show errors

            if (parsed) {
                dialog.querySelector('#git-org').value = parsed.org;
                dialog.querySelector('#git-repo').value = parsed.repo;
                dialog.querySelector('#git-branch').value = parsed.branch;

                // Try to get the actual default branch from GitHub
                try {
                    const defaultBranch = await getGitHubDefaultBranch(parsed.org, parsed.repo);
                    if (defaultBranch && parsed.branch === 'main') { // Only update if we were guessing
                        dialog.querySelector('#git-branch').value = defaultBranch;
                    }
                } catch (error) {
                    // Ignore - just use what we parsed
                }

                pasteError.style.display = 'none';
            }
        } catch (error) {
            pasteError.textContent = 'Paste failed: ' + error.message;
            pasteError.style.display = 'block';
        }
    });

    // Browse base folder button
    const browseBtn = dialog.querySelector('#browse-base-folder');
    browseBtn.addEventListener('click', async function() {
        try {
            const result = await ipcRenderer.invoke('select-folder');
            if (!result.canceled && result.filePaths.length > 0) {
                dialog.querySelector('#base-folder').value = result.filePaths[0];
            }
        } catch (error) {
            console.log('Error selecting folder:', error);
        }
    });
}

// Convert the Pascal parsing logic to JavaScript
function parseGitHubUrl(url, showError) {
    try {
        if (!url || typeof url !== 'string') {
            throw new Error('Not a valid URL');
        }

        url = url.trim();

        // Check if it's an absolute URL
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            throw new Error('Not a URL: ' + url);
        }

        let branch = 'main'; // Default to 'main' instead of 'master'
        let org = '';
        let repo = '';

        const parts = url.split('/');

        // Parse build.fhir.org URLs: https://build.fhir.org/ig/org/repo/branches/branch
        if (parts.length > 5 && (url.startsWith('https://build.fhir.org/ig') || url.startsWith('http://build.fhir.org/ig'))) {
            org = parts[4];
            repo = parts[5];

            if (parts.length >= 8) {
                if (parts[6] !== 'branches') {
                    throw new Error('Unable to understand IG location: ' + url);
                } else {
                    branch = parts[7];
                }
            }
        }
        // Parse GitHub URLs: https://github.com/org/repo/tree/branch or https://github.com/org/repo/blob/branch
        else if (parts.length > 4 && (url.startsWith('https://github.com/') || url.startsWith('http://github.com/'))) {
            org = parts[3];
            repo = parts[4];

            if (parts.length > 6) {
                if (parts[5] === 'tree' || parts[5] === 'blob') {
                    branch = parts[6];
                } else {
                    throw new Error('Unable to understand IG location: ' + url);
                }
            }
        } else {
            throw new Error('URL must be from github.com or build.fhir.org');
        }

        if (!org || !repo) {
            throw new Error('Unable to understand IG location: ' + url);
        }

        return {
            org: org,
            repo: repo,
            branch: branch
        };

    } catch (error) {
        if (showError) {
            const pasteError = document.getElementById('paste-error');
            if (pasteError) {
                pasteError.textContent = 'URL Error: ' + error.message;
                pasteError.style.display = 'block';
            }
        }
        return null;
    }
}

// Get the default branch from GitHub API
async function getGitHubDefaultBranch(org, repo) {
    try {
        const response = await fetch(`https://api.github.com/repos/${org}/${repo}`, {
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'IG-Publisher-Manager'
            }
        });

        if (!response.ok) {
            throw new Error('GitHub API request failed: ' + response.status);
        }

        const repoInfo = await response.json();
        return repoInfo.default_branch;

    } catch (error) {
        console.log('Failed to get default branch:', error);
        throw error;
    }
}

// Clone the repository
async function cloneGitHubRepository(config) {
    const { baseFolder, org, repo, branch } = config;

    // Create target folder name: org-repo-branch
    const folderName = `${org}-${repo}-${branch}`;
    const targetPath = path.join(baseFolder, folderName);

    // Check if folder already exists
    if (fs.existsSync(targetPath)) {
        const overwrite = confirm(`Folder "${folderName}" already exists. Overwrite?`);
        if (!overwrite) {
            appendToBuildOutput('Clone cancelled - folder already exists');
            return;
        }

        try {
            await ipcRenderer.invoke('delete-folder', targetPath);
        } catch (error) {
            appendToBuildOutput('Failed to delete existing folder: ' + error.message);
            return;
        }
    }

    appendToBuildOutput(`Cloning ${org}/${repo} (${branch}) to ${targetPath}...`);

    try {
        // Create a temporary IG entry for console output
        const tempIg = {
            name: `${org}/${repo}`,
            folder: targetPath,
            console: ''
        };

        resetIgConsole(tempIg, 'Git Clone');

        const gitUrl = `https://github.com/${org}/${repo}.git`;
        appendToIgConsole(tempIg, `Cloning from: ${gitUrl}`);
        appendToIgConsole(tempIg, `Branch: ${branch}`);
        appendToIgConsole(tempIg, `Target: ${targetPath}`);

        await runGitClone(tempIg, gitUrl, targetPath, branch);

        // Add the cloned repository to our IG list
        await addIgFromFolder(targetPath);

        appendToIgConsole(tempIg, '✓ Repository cloned and added successfully');

    } catch (error) {
        appendToBuildOutput('✗ Clone failed: ' + error.message);
    }
}

// Run git clone command
function runGitClone(ig, gitUrl, targetPath, branch) {
    return new Promise(function(resolve, reject) {
        const spawn = require('child_process').spawn;

        const args = ['clone', '--branch', branch, '--single-branch', gitUrl, targetPath];
        appendToIgConsole(ig, '> git ' + args.join(' '));

        const git = spawn('git', args, {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let hasOutput = false;

        git.stdout.on('data', function(data) {
            hasOutput = true;
            const text = data.toString();
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].trim()) {
                    const cleanLine = stripAnsiCodes(lines[i].trim());
                    appendToIgConsole(ig, cleanLine);
                }
            }
        });

        git.stderr.on('data', function(data) {
            hasOutput = true;
            const text = data.toString();
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].trim()) {
                    const cleanLine = stripAnsiCodes(lines[i].trim());
                    appendToIgConsole(ig, cleanLine);
                }
            }
        });

        git.on('close', function(code) {
            if (code === 0) {
                if (!hasOutput) {
                    appendToIgConsole(ig, 'Clone completed (no output)');
                }
                resolve();
            } else {
                const errorMsg = 'Git clone failed with exit code ' + code;
                appendToIgConsole(ig, errorMsg);
                reject(new Error(errorMsg));
            }
        });

        git.on('error', function(error) {
            let message = 'Git clone error: ' + error.message;
            if (error.code === 'ENOENT') {
                message = 'Git not found. Please install Git and ensure it\'s in your PATH.';
            }
            appendToIgConsole(ig, message);
            reject(new Error(message));
        });
    });
}

function setupResizer() {
    const resizer = document.getElementById('resizer');
    const igListContainer = document.querySelector('.ig-list-container');
    const buildOutputContainer = document.querySelector('.build-output-container');
    const mainContent = document.querySelector('.main-content');

    if (!resizer || !igListContainer || !buildOutputContainer || !mainContent) {
        console.log('Resizer elements not found');
        return;
    }

    let isResizing = false;
    let startY = 0;
    let startIgHeight = 0;
    let startOutputHeight = 0;

    resizer.addEventListener('mousedown', function(e) {
        isResizing = true;
        startY = e.clientY;

        // Get current heights
        const igRect = igListContainer.getBoundingClientRect();
        const outputRect = buildOutputContainer.getBoundingClientRect();
        startIgHeight = igRect.height;
        startOutputHeight = outputRect.height;

        // Add visual feedback
        resizer.style.background = '#007acc';
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';

        // Prevent text selection during drag
        e.preventDefault();
    });

    document.addEventListener('mousemove', function(e) {
        if (!isResizing) return;

        const deltaY = e.clientY - startY;
        const mainContentRect = mainContent.getBoundingClientRect();
        const resizerHeight = 4; // Height of the resizer itself

        // Calculate new heights
        let newIgHeight = startIgHeight + deltaY;
        let newOutputHeight = startOutputHeight - deltaY;

        // Set minimum heights
        const minHeight = 100;
        const maxIgHeight = mainContentRect.height - minHeight - resizerHeight;
        const maxOutputHeight = mainContentRect.height - minHeight - resizerHeight;

        // Constrain the heights
        newIgHeight = Math.max(minHeight, Math.min(newIgHeight, maxIgHeight));
        newOutputHeight = Math.max(minHeight, Math.min(newOutputHeight, maxOutputHeight));

        // Apply the new heights
        igListContainer.style.height = newIgHeight + 'px';
        buildOutputContainer.style.height = newOutputHeight + 'px';

        // Store the heights for persistence
        localStorage.setItem('igListHeight', newIgHeight);
        localStorage.setItem('buildOutputHeight', newOutputHeight);
    });

    document.addEventListener('mouseup', function() {
        if (isResizing) {
            isResizing = false;

            // Remove visual feedback
            resizer.style.background = '#ddd';
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });

    // Handle cursor change on hover
    resizer.addEventListener('mouseenter', function() {
        if (!isResizing) {
            resizer.style.background = '#007acc';
        }
    });

    resizer.addEventListener('mouseleave', function() {
        if (!isResizing) {
            resizer.style.background = '#ddd';
        }
    });
}

// Function to restore saved heights
function restorePanelHeights() {
    const igListContainer = document.querySelector('.ig-list-container');
    const buildOutputContainer = document.querySelector('.build-output-container');

    try {
        const savedIgHeight = localStorage.getItem('igListHeight');
        const savedOutputHeight = localStorage.getItem('buildOutputHeight');

        if (savedIgHeight && savedOutputHeight) {
            igListContainer.style.height = savedIgHeight + 'px';
            buildOutputContainer.style.height = savedOutputHeight + 'px';
        }
    } catch (error) {
        console.log('Could not restore panel heights:', error);
    }
}


function showIgContextMenu(event) {
    const ig = getSelectedIg();
    if (!ig) return;

    const menu = document.getElementById('ig-context-menu');

    // Update menu item states based on current conditions
    updateContextMenuStates(menu, ig);

    // Position the menu
    menu.style.display = 'block';
    menu.style.left = event.pageX + 'px';
    menu.style.top = event.pageY + 'px';

    // Adjust position if menu would go off screen
    const rect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (rect.right > viewportWidth) {
        menu.style.left = (viewportWidth - rect.width - 5) + 'px';
    }

    if (rect.bottom > viewportHeight) {
        menu.style.top = (viewportHeight - rect.height - 5) + 'px';
    }

    event.stopPropagation();
}

function updateContextMenuStates(menu, ig) {
    const isBuilding = buildProcesses.has(selectedIgIndex);
    const isGitRepo = checkIfGitRepo(ig.folder);
    const hasIgOutput = checkFileExists(ig.folder, 'output/index.html');
    const hasQaOutput = checkFileExists(ig.folder, 'output/qa.html');

    // Get all menu items
    const menuItems = menu.querySelectorAll('.context-menu-item[data-action]');

    menuItems.forEach(function(item) {
        const action = item.dataset.action;
        let enabled = true;

        switch (action) {
            case 'build':
                enabled = !isBuilding;
                break;
            case 'stop':
                enabled = isBuilding;
                break;
            case 'open-ig':
                enabled = hasIgOutput;
                break;
            case 'open-qa':
                enabled = hasQaOutput;
                break;
            case 'update':
                enabled = isGitRepo;
                break;
          // copy-path, copy-github, open-folder, open-terminal are always enabled
        }

        if (enabled) {
            item.classList.remove('disabled');
        } else {
            item.classList.add('disabled');
        }
    });
}

// Add this function to renderer.js

function setupIgContextMenu() {
    const menu = document.getElementById('ig-context-menu');
    const menuItems = menu.querySelectorAll('.context-menu-item[data-action]');

    menuItems.forEach(function(item) {
        item.addEventListener('click', async function(e) {
            if (item.classList.contains('disabled')) {
                return;
            }

            const action = item.dataset.action;
            const ig = getSelectedIg();
            if (!ig) return;

            closeContextMenus();

            // Execute the action
            switch (action) {
                case 'build':
                    buildIg();
                    break;
                case 'stop':
                    stopBuild();
                    break;
                case 'open-ig':
                    await openIG();
                    break;
                case 'open-qa':
                    await openQA();
                    break;
                case 'copy-path':
                    await handleCopyAction('copy-folder-path', ig.folder);
                    break;
                case 'copy-github':
                    try {
                        const gitUrl = await getGitRemoteUrl(ig.folder);
                        await handleCopyAction('copy-github-url', gitUrl);
                    } catch (error) {
                        appendToBuildOutput('GitHub URL not available: ' + error.message);
                    }
                    break;
                case 'update':
                    await updateSource();
                    break;
                case 'open-folder':
                    await openFolder(ig);
                    break;
                case 'open-terminal':
                    await openTerminal(ig);
                    break;
            }
        });
    });
}

// Update the closeContextMenus function to include the new menu

function closeContextMenus() {
    const copyMenu = document.getElementById('copy-menu');
    const toolsMenu = document.getElementById('tools-menu');
    const igContextMenu = document.getElementById('ig-context-menu');
    const buildOutputContextMenu = document.getElementById('build-output-context-menu');

    if (copyMenu) copyMenu.style.display = 'none';
    if (toolsMenu) toolsMenu.style.display = 'none';
    if (igContextMenu) igContextMenu.style.display = 'none';
    if (buildOutputContextMenu) buildOutputContextMenu.style.display = 'none';
    const documentationMenu = document.getElementById('documentation-menu');
    if (documentationMenu) documentationMenu.style.display = 'none';

}

// Update the setupContextMenus function to include the new menu

function setupContextMenus() {
    // Tools menu items
    const toolsMenuItems = document.querySelectorAll('#tools-menu .context-menu-item');
    for (let i = 0; i < toolsMenuItems.length; i++) {
        toolsMenuItems[i].addEventListener('click', function(e) {
            if (this.classList.contains('disabled')) {
                e.preventDefault();
                return;
            }

            const action = e.target.dataset.action;
            handleToolsAction(action);
            closeContextMenus();
        });
    }

    // IG context menu
    setupIgContextMenu();
    setupBuildOutputContextMenu();
    // Documentation menu items
    const documentationMenuItems = document.querySelectorAll('#documentation-menu .context-menu-item');
    for (let i = 0; i < documentationMenuItems.length; i++) {
        documentationMenuItems[i].addEventListener('click', function(e) {
            const action = e.target.dataset.action;
            handleDocumentationAction(action);
            closeContextMenus();
        });
    }
}

function setupBuildOutput() {
    const buildOutput = document.getElementById('build-output');
    if (!buildOutput) return;

    // Make it focusable for keyboard events
    buildOutput.setAttribute('tabindex', '0');

    // Add keyboard event listener for copy
    buildOutput.addEventListener('keydown', function(e) {
        // Ctrl+C (Windows/Linux) or Cmd+C (Mac)
        if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
            copySelectedText();
            e.preventDefault(); // Prevent default browser copy behavior
        }

        // Ctrl+A (Windows/Linux) or Cmd+A (Mac) - Select all
        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
            selectAllLogText();
            e.preventDefault();
        }
    });

    // Add context menu support
    buildOutput.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        showBuildOutputContextMenu(e);
    });

    // Focus when clicked to enable keyboard shortcuts
    buildOutput.addEventListener('click', function() {
        buildOutput.focus();
    });
}

// Copy currently selected text
function copySelectedText() {
    try {
        const selection = window.getSelection();
        const selectedText = selection.toString();

        if (selectedText) {
            navigator.clipboard.writeText(selectedText).then(function() {
                // Visual feedback - briefly highlight the build output
                const buildOutput = document.getElementById('build-output');
                buildOutput.style.backgroundColor = '#e3f2fd';
                setTimeout(function() {
                    buildOutput.style.backgroundColor = '#fafafa';
                }, 200);

                console.log('Copied selected text to clipboard');
            }).catch(function(err) {
                console.log('Failed to copy selected text:', err);
                // Fallback - try using document.execCommand
                try {
                    document.execCommand('copy');
                } catch (fallbackErr) {
                    console.log('Fallback copy also failed:', fallbackErr);
                }
            });
        } else {
            // No text selected, copy all log content
            copyAllLogText();
        }
    } catch (error) {
        console.log('Error copying text:', error);
    }
}

// Select all text in the log
function selectAllLogText() {
    const buildOutput = document.getElementById('build-output');
    if (!buildOutput) return;

    const range = document.createRange();
    range.selectNodeContents(buildOutput);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
}

// Copy all log text
function copyAllLogText() {
    const ig = getSelectedIg();
    if (!ig) return;

    initializeIgConsole(ig);
    const logText = ig.console || 'No log content';

    navigator.clipboard.writeText(logText).then(function() {
        const buildOutput = document.getElementById('build-output');
        buildOutput.style.backgroundColor = '#e3f2fd';
        setTimeout(function() {
            buildOutput.style.backgroundColor = '#fafafa';
        }, 200);

        console.log('Copied all log text to clipboard');
    }).catch(function(err) {
        console.log('Failed to copy all log text:', err);
    });
}

// Clear the current IG's log
function clearCurrentLog() {
    const ig = getSelectedIg();
    if (!ig) return;

    initializeIgConsole(ig);
    ig.console = '';
    updateBuildOutputDisplay();

}

// Show build output context menu
function showBuildOutputContextMenu(event) {
    const menu = document.getElementById('build-output-context-menu');

    // Update menu item states
    updateBuildOutputContextMenuStates(menu);

    // Position the menu
    menu.style.display = 'block';
    menu.style.left = event.pageX + 'px';
    menu.style.top = event.pageY + 'px';

    // Adjust position if menu would go off screen
    const rect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (rect.right > viewportWidth) {
        menu.style.left = (viewportWidth - rect.width - 5) + 'px';
    }

    if (rect.bottom > viewportHeight) {
        menu.style.top = (viewportHeight - rect.height - 5) + 'px';
    }

    event.stopPropagation();
}

function updateBuildOutputContextMenuStates(menu) {
    const selection = window.getSelection();
    const hasSelection = selection.toString().length > 0;
    const ig = getSelectedIg();
    const hasLogContent = ig && ig.console && ig.console.length > 0;

    const menuItems = menu.querySelectorAll('.context-menu-item[data-action]');

    menuItems.forEach(function(item) {
        const action = item.dataset.action;
        let enabled = true;

        switch (action) {
            case 'copy-selected':
                enabled = hasSelection;
                break;
            case 'copy-all':
                enabled = hasLogContent;
                break;
            case 'clear-log':
                enabled = hasLogContent;
                break;
        }

        if (enabled) {
            item.classList.remove('disabled');
        } else {
            item.classList.add('disabled');
        }
    });
}

// Setup build output context menu
function setupBuildOutputContextMenu() {
    const menu = document.getElementById('build-output-context-menu');
    const menuItems = menu.querySelectorAll('.context-menu-item[data-action]');

    menuItems.forEach(function(item) {
        item.addEventListener('click', function(e) {
            if (item.classList.contains('disabled')) {
                return;
            }

            const action = item.dataset.action;
            closeContextMenus();

            switch (action) {
                case 'copy-selected':
                    copySelectedText();
                    break;
                case 'copy-all':
                    copyAllLogText();
                    break;
                case 'clear-log':
                    clearCurrentLog();
                    break;
            }
        });
    });
}

async function getCurrentGitBranch(folder) {
    return new Promise(function(resolve, reject) {
        if (!fs.existsSync(path.join(folder, '.git'))) {
            resolve(null); // Not a git repository
            return;
        }

        const spawn = require('child_process').spawn;
        const git = spawn('git', ['branch', '--show-current'], {
            cwd: folder,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let output = '';

        git.stdout.on('data', function(data) {
            output += data.toString().trim();
        });

        git.on('close', function(code) {
            if (code === 0 && output) {
                resolve(output);
            } else {
                // Fallback: try to get branch from HEAD
                const headPath = path.join(folder, '.git', 'HEAD');
                try {
                    if (fs.existsSync(headPath)) {
                        const headContent = fs.readFileSync(headPath, 'utf8').trim();
                        if (headContent.startsWith('ref: refs/heads/')) {
                            const branchName = headContent.substring('ref: refs/heads/'.length);
                            resolve(branchName);
                        } else {
                            resolve('detached'); // Detached HEAD state
                        }
                    } else {
                        resolve(null);
                    }
                } catch (error) {
                    resolve(null);
                }
            }
        });

        git.on('error', function(error) {
            resolve(null); // Git not available or other error
        });
    });
}

// Function to check for changes in an IG
async function checkIgForChanges(ig, index) {
    try {
        let hasChanges = false;

        // Check for version changes by re-reading package info
        try {
            const packageInfo = await getPackageId(ig.folder);

            // Check if version changed
            if (packageInfo.version !== ig.version) {
                console.log(`Version changed for ${ig.name}: ${ig.version} -> ${packageInfo.version}`);
                ig.version = packageInfo.version;
                hasChanges = true;
            }

            // Check if name/title changed
            if (packageInfo.title !== ig.name) {
                console.log(`Name changed for ${ig.name}: ${ig.name} -> ${packageInfo.title}`);
                ig.name = packageInfo.title;
                hasChanges = true;
            }
        } catch (error) {
            // Couldn't read package info - that's okay, skip version check
        }

        // Check for git branch changes
        const currentBranch = await getCurrentGitBranch(ig.folder);
        if (currentBranch !== ig.gitBranch) {
            console.log(`Branch changed for ${ig.name}: ${ig.gitBranch || 'none'} -> ${currentBranch || 'none'}`);
            ig.gitBranch = currentBranch;
            hasChanges = true;
        }

        return hasChanges;
    } catch (error) {
        console.log('Error checking IG for changes:', error);
        return false;
    }
}

// Enhanced file watcher that checks for IG changes
function startFileWatcher() {
    fileWatcher = setInterval(async function() {
        updateButtonStates();

        const needsTimeUpdate = igList.some(ig => ig.lastBuildStart);
        if (needsTimeUpdate) {
            updateIgList(); // This will refresh the relative time displays
        }

        // Check each IG for changes (but not too frequently)
        // Only check every 3rd iteration (every 15 seconds instead of 5)
        if (!fileWatcher.checkCount) fileWatcher.checkCount = 0;
        fileWatcher.checkCount++;

        if (fileWatcher.checkCount % 3 === 0) {
            await checkAllIgsForChanges();
        }
    }, 5000);
}

// Function to check all IGs for changes
async function checkAllIgsForChanges() {
    let anyChanges = false;

    for (let i = 0; i < igList.length; i++) {
        const ig = igList[i];
        const hasChanges = await checkIgForChanges(ig, i);
        if (hasChanges) {
            anyChanges = true;
        }
    }

    if (anyChanges) {
        updateIgList();
        saveIgList();

        // Show a subtle notification
        const selectedIg = getSelectedIg();
        if (selectedIg) {
            appendToIgConsole(selectedIg, 'ℹ️ Detected changes in project metadata');
        }
    }
}

function saveSortState() {
    try {
        localStorage.setItem('igListSortState', JSON.stringify(sortState));
    } catch (error) {
        console.log('Could not save sort state:', error);
    }
}

function loadSortState() {
    try {
        const saved = localStorage.getItem('igListSortState');
        if (saved) {
            const parsed = JSON.parse(saved);
            sortState.column = parsed.column;
            sortState.direction = parsed.direction;
        }
    } catch (error) {
        console.log('Could not load sort state:', error);
    }
}

// Sorting functions
function compareValues(a, b, column) {
    let aVal = a[column];
    let bVal = b[column];

    // Handle null/undefined values - put them at the end
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;

    switch (column) {
        case 'version':
            return compareVersions(String(aVal), String(bVal));
        case 'buildTime':
            return compareBuildTimes(String(aVal), String(bVal));
        case 'builtSize':
            return compareFileSizes(String(aVal), String(bVal));
        case 'buildStatus':
            return compareBuildStatus(String(aVal), String(bVal));
        case 'gitBranch':
            return compareGitBranches(String(aVal), String(bVal));
        case 'lastBuildStart':
            return compareLastBuild(aVal, bVal);  // NEW
        default:
            // Default string comparison (case insensitive)
            return String(aVal).toLowerCase().localeCompare(String(bVal).toLowerCase());
    }
}

function compareVersions(a, b) {
    // Handle special cases (case insensitive)
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();

    if (aLower === 'unknown' && bLower === 'unknown') return 0;
    if (aLower === 'unknown') return 1;
    if (bLower === 'unknown') return -1;

    // Split versions into parts and compare numerically where possible
    const aParts = a.split(/[.\-]/);
    const bParts = b.split(/[.\-]/);
    const maxLength = Math.max(aParts.length, bParts.length);

    for (let i = 0; i < maxLength; i++) {
        const aPart = aParts[i] || '0';
        const bPart = bParts[i] || '0';

        // Try to compare as numbers first
        const aNum = parseInt(aPart, 10);
        const bNum = parseInt(bPart, 10);

        if (!isNaN(aNum) && !isNaN(bNum)) {
            if (aNum !== bNum) return aNum - bNum;
        } else {
            // Fall back to case-insensitive string comparison
            const comparison = aPart.toLowerCase().localeCompare(bPart.toLowerCase());
            if (comparison !== 0) return comparison;
        }
    }

    return 0;
}

function compareBuildTimes(a, b) {
    // Handle special cases
    if (a === '-' && b === '-') return 0;
    if (a === '-') return 1;
    if (b === '-') return -1;

    // Parse time strings like "2:34" or "1:12"
    const parseTime = (timeStr) => {
        const parts = timeStr.split(':');
        if (parts.length === 2) {
            return parseInt(parts[0]) * 60 + parseInt(parts[1]);
        }
        return 0;
    };

    return parseTime(a) - parseTime(b);
}

function compareFileSizes(a, b) {
    // Handle special cases
    if (a === '-' && b === '-') return 0;
    if (a === '-') return 1;
    if (b === '-') return -1;

    // Parse size strings like "15.2 MB" or "8.7 MB" (case insensitive)
    const parseSize = (sizeStr) => {
        const match = sizeStr.match(/^([\d.]+)\s*(MB|KB|GB)/i);
        if (match) {
            const value = parseFloat(match[1]);
            const unit = match[2].toUpperCase();
            switch (unit) {
                case 'GB': return value * 1024 * 1024;
                case 'MB': return value * 1024;
                case 'KB': return value;
                default: return value;
            }
        }
        return 0;
    };

    return parseSize(a) - parseSize(b);
}

function compareBuildStatus(a, b) {
    // Define status priority order (case insensitive)
    const statusOrder = {
        'success': 1,
        'building': 2,
        'error': 3,
        'stopped': 4,
        'not built': 5
    };

    const aOrder = statusOrder[a.toLowerCase()] || 999;
    const bOrder = statusOrder[b.toLowerCase()] || 999;

    return aOrder - bOrder;
}

function compareGitBranches(a, b) {
    // Handle special cases
    if (a === '-' && b === '-') return 0;
    if (a === '-') return 1;
    if (b === '-') return -1;

    // Prioritize common branches (case insensitive)
    const branchPriority = {
        'main': 1,
        'master': 2,
        'develop': 3,
        'dev': 4
    };

    const aPriority = branchPriority[a.toLowerCase()] || 999;
    const bPriority = branchPriority[b.toLowerCase()] || 999;

    if (aPriority !== bPriority) {
        return aPriority - bPriority;
    }

    // Fall back to case-insensitive alphabetical
    return a.toLowerCase().localeCompare(b.toLowerCase());
}

// NEW FUNCTION: Compare last build timestamps
function compareLastBuild(a, b) {
    // Handle null/undefined timestamps - they go to the end
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;

    // More recent builds should come first (descending by default for this column)
    return b - a;
}

function sortIgList() {
    if (!sortState.column) return;

    const dataColumn = sortState.columnMap[sortState.column];
    if (!dataColumn) return;

    igList.sort((a, b) => {
        const comparison = compareValues(a, b, dataColumn);
        return sortState.direction === 'asc' ? comparison : -comparison;
    });
}

function handleColumnHeaderClick(columnName) {
    if (sortState.column === columnName) {
        // Same column - toggle direction
        sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc';
    } else {
        // New column - default to ascending
        sortState.column = columnName;
        sortState.direction = 'asc';
    }

    saveSortState();
    updateIgList();
}

function updateColumnHeaders() {
    const headers = document.querySelectorAll('.ig-list th[data-column]');

    headers.forEach(th => {
        const columnName = th.dataset.column;

        // Remove existing sort indicators
        th.textContent = columnName;
        th.classList.remove('sort-asc', 'sort-desc');

        // Add current sort indicator
        if (sortState.column === columnName) {
            const indicator = sortState.direction === 'asc' ? ' ↑' : ' ↓';
            th.textContent = columnName + indicator;
            th.classList.add(`sort-${sortState.direction}`);
        }
    });
}

function setupColumnHeaderListeners() {
    // Wait for DOM to be ready, then set up listeners
    setTimeout(() => {
        const headers = document.querySelectorAll('.ig-list th[data-column]');
        headers.forEach(th => {
            th.style.cursor = 'pointer';
            th.style.userSelect = 'none';
            th.addEventListener('click', () => {
                handleColumnHeaderClick(th.dataset.column);
            });
        });
    }, 100);
}

function formatRelativeTime(timestamp) {
    if (!timestamp) return '-';

    const now = Date.now();
    const diffMs = now - timestamp;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);
    const diffWeek = Math.floor(diffDay / 7);

    if (diffSec < 60) {
        return 'just now';
    } else if (diffMin < 60) {
        return diffMin === 1 ? '1 min ago' : `${diffMin} mins ago`;
    } else if (diffHour < 24) {
        return diffHour === 1 ? '1 hr ago' : `${diffHour} hrs ago`;
    } else if (diffDay < 7) {
        return diffDay === 1 ? '1 day ago' : `${diffDay} days ago`;
    } else if (diffWeek < 4) {
        return diffWeek === 1 ? '1 wk ago' : `${diffWeek} wks ago`;
    } else {
        const diffMonth = Math.floor(diffDay / 30);
        if (diffMonth < 12) {
            return diffMonth === 1 ? '1 mo ago' : `${diffMonth} mos ago`;
        } else {
            const diffYear = Math.floor(diffDay / 365);
            return diffYear === 1 ? '1 yr ago' : `${diffYear} yrs ago`;
        }
    }
}

function showDocumentationMenu(event) {
    const menu = document.getElementById('documentation-menu');
    const rect = event.target.getBoundingClientRect();

    menu.style.display = 'block';
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.bottom + 5) + 'px';

    event.stopPropagation();
}

async function handleDocumentationAction(action) {
    const documentationUrls = {
        'ig-getting-started': 'https://hl7.github.io/docs/ig_publisher/getting-started',
        'ig-using-tool': 'https://confluence.hl7.org/spaces/FHIR/pages/35718627/IG+Publisher+Documentation',
        'ig-writing-igs': 'https://build.fhir.org/ig/FHIR/ig-guidance/',
        'sushi-docs': 'https://github.com/FHIR/sushi',
        'fsh-docs': 'https://build.fhir.org/ig/HL7/fhir-shorthand/',
        'publishing-website': 'https://build.fhir.org/ig/ElliotSilver/how-to-publish/publication.html',
        'fhir-validator': 'https://confluence.hl7.org/spaces/FHIR/pages/35718580/Using+the+FHIR+Validator',
        'check-updates': 'https://github.com/FHIR/ig-publisher-manager/releases'
    };

    const url = documentationUrls[action];
    if (url) {
        try {
            appendToBuildOutput('Opening documentation: ' + url);
            await ipcRenderer.invoke('open-external', url);
        } catch (error) {
            appendToBuildOutput('Failed to open documentation: ' + error.message);
        }
    }
}

function updateToolsMenuStates(canPublishToWebsite) {
    const publishItem = document.querySelector('#tools-menu .context-menu-item[data-action="publish-to-website"]');
    if (publishItem) {
        if (canPublishToWebsite) {
            publishItem.classList.remove('disabled');
        } else {
            publishItem.classList.add('disabled');
        }
    }
}

// 4. ADD function to load publication settings
function loadPublicationSettings() {
    try {
        const settings = JSON.parse(localStorage.getItem('publicationSettings') || '{}');
        return {
            websiteFolder: settings.websiteFolder || '',
            registryFile: settings.registryFile || '',
            historyTemplates: settings.historyTemplates || '',
            webTemplates: settings.webTemplates || '',
            zipArchive: settings.zipArchive || ''
        };
    } catch (error) {
        console.log('Could not load publication settings:', error);
        return {
            websiteFolder: '',
            registryFile: '',
            historyTemplates: '',
            webTemplates: '',
            zipArchive: ''
        };
    }
}

// 5. ADD function to save publication settings
function savePublicationSettings(settings) {
    try {
        localStorage.setItem('publicationSettings', JSON.stringify(settings));
    } catch (error) {
        console.log('Could not save publication settings:', error);
    }
}

// 6. ADD function to read publication request file
async function readPublicationRequest(folder) {
    try {
        const publicationRequestPath = path.join(folder, 'publication-request.json');
        if (!fs.existsSync(publicationRequestPath)) {
            throw new Error('publication-request.json file not found');
        }

        const content = fs.readFileSync(publicationRequestPath, 'utf8');

        // Try to parse as JSON first
        try {
            return JSON.parse(content);
        } catch (jsonError) {
            // If not JSON, try to parse as simple key-value format
            const result = {};
            const lines = content.split('\n');

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    const colonIndex = trimmed.indexOf(':');
                    if (colonIndex > 0) {
                        const key = trimmed.substring(0, colonIndex).trim();
                        const value = trimmed.substring(colonIndex + 1).trim();
                        result[key] = value;
                    }
                }
            }
            return result;
        }
    } catch (error) {
        throw new Error(`Failed to read publication-request.json: ${error.message}`);
    }
}

// 7. ADD function to read QA JSON file
async function readQAJson(folder) {
    try {
        const qaJsonPath = path.join(folder, 'output', 'qa.json');
        if (!fs.existsSync(qaJsonPath)) {
            throw new Error('qa.json file not found in output folder');
        }

        const content = fs.readFileSync(qaJsonPath, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        throw new Error(`Failed to read qa.json: ${error.message}`);
    }
}

// 8. ADD function to validate publication data
async function validatePublicationData(ig) {
    const validation = {
        success: true,
        messages: [],
        publicationRequest: null,
        qaData: null
    };

    try {
        // Read publication request
        validation.publicationRequest = await readPublicationRequest(ig.folder);
        validation.messages.push('✓ Publication request file loaded successfully');
    } catch (error) {
        validation.success = false;
        validation.messages.push(`✗ ${error.message}`);
        return validation;
    }

    try {
        // Read QA JSON
        validation.qaData = await readQAJson(ig.folder);
        validation.messages.push('✓ QA JSON file loaded successfully');
    } catch (error) {
        validation.success = false;
        validation.messages.push(`✗ ${error.message}`);
        return validation;
    }

    // Validate package ID match
    const pubPackageId = validation.publicationRequest.packageId || validation.publicationRequest['package-id'];
    const qaPackageId = validation.qaData['package-id'];

    if (pubPackageId && qaPackageId) {
        if (pubPackageId === qaPackageId) {
            validation.messages.push('✓ Package IDs match');
        } else {
            validation.success = false;
            validation.messages.push(`✗ Package ID mismatch: publication-request.json has "${pubPackageId}", qa.json has "${qaPackageId}"`);
        }
    } else {
        validation.messages.push('⚠ Could not verify package ID match (missing data)');
    }

    // Validate version match
    const pubVersion = validation.publicationRequest.version || validation.publicationRequest['ig-version'];
    const qaVersion = validation.qaData['ig-ver'];

    if (pubVersion && qaVersion) {
        if (pubVersion === qaVersion) {
            validation.messages.push('✓ Versions match');
        } else {
            validation.success = false;
            validation.messages.push(`✗ Version mismatch: publication-request.json has "${pubVersion}", qa.json has "${qaVersion}"`);
        }
    } else {
        validation.messages.push('⚠ Could not verify version match (missing data)');
    }

    const currentSettings = getCurrentSettings();
    if (currentSettings.igPublisherVersion !== 'latest') {
        validation.success = false;
        validation.messages.push(`✗ IG Publisher version must be "latest", currently set to "${currentSettings.igPublisherVersion}"`);
    }

    // NEW: Check that no option checkboxes are selected
    const optionErrors = [];
    if (currentSettings.noNarrative) {
        optionErrors.push('No Narrative');
    }
    if (currentSettings.noValidation) {
        optionErrors.push('No Validation');
    }
    if (currentSettings.noNetwork) {
        optionErrors.push('No Network');
    }
    if (currentSettings.noSushi) {
        optionErrors.push('No Sushi');
    }
    if (currentSettings.debugging) {
        optionErrors.push('Debugging');
    }
    if (optionErrors.length > 0) {
        validation.success = false;
        validation.messages.push(`✗ Publication options must be disabled. Currently enabled: ${optionErrors.join(', ')}`);
    }

    return validation;
}

// 9. ADD function to show the publish to website dialog
async function showPublishToWebsiteDialog(ig) {
    // Check prerequisites
    if (!checkFileExists(ig.folder, 'output/qa.json')) {
        appendToBuildOutput('✗ qa.json not found in output folder. Build the IG first.');
        return;
    }

    if (!checkFileExists(ig.folder, 'publication-request.json')) {
        appendToBuildOutput('✗ publication-request.json file not found in IG folder.');
        return;
    }

    // Validate publication data
    const validation = await validatePublicationData(ig);

    // Load saved settings
    const settings = loadPublicationSettings();

    return new Promise(function(resolve) {
        const dialog = document.createElement('div');
        dialog.innerHTML = createPublishDialogHTML(ig, validation, settings);

        // Add resolver function to window
        window.resolvePublishDialog = function(action) {
            if (action === 'go') {
                const newSettings = {
                    websiteFolder: document.getElementById('pub-website-folder').value.trim(),
                    registryFile: document.getElementById('pub-registry-file').value.trim(),
                    historyTemplates: document.getElementById('pub-history-templates').value.trim(),
                    webTemplates: document.getElementById('pub-web-templates').value.trim(),
                    zipArchive: document.getElementById('pub-zip-archive').value.trim()
                };

                // Validate required fields
                if (!newSettings.websiteFolder || !newSettings.registryFile ||
                  !newSettings.historyTemplates || !newSettings.webTemplates ||
                  !newSettings.zipArchive) {
                    alert('Please fill in all required fields');
                    return;
                }

                // NEW: Check for spaces in paths
                const pathsWithSpaces = validateNoSpacesInPaths(newSettings);
                if (pathsWithSpaces.length > 0) {
                    alert(`Error: The following paths contain spaces, which are not allowed:\n\n${pathsWithSpaces.join('\n')}\n\nPlease use paths without spaces.`);
                    return;
                }

                // Save settings
                savePublicationSettings(newSettings);

                document.body.removeChild(dialog);
                delete window.resolvePublishDialog;

                // NEW: Start the publication process
                startPublishProcess(ig, newSettings);
                resolve('go');
            } else {
                document.body.removeChild(dialog);
                delete window.resolvePublishDialog;
                resolve('cancel');
            }
        };

        document.body.appendChild(dialog);
        setupPublishDialogListeners(dialog);
    });
}

function validateNoSpacesInPaths(settings) {
    const pathsWithSpaces = [];

    if (settings.websiteFolder && settings.websiteFolder.includes(' ')) {
        pathsWithSpaces.push('Web Site Folder: ' + settings.websiteFolder);
    }
    if (settings.registryFile && settings.registryFile.includes(' ')) {
        pathsWithSpaces.push('Registry File: ' + settings.registryFile);
    }
    if (settings.historyTemplates && settings.historyTemplates.includes(' ')) {
        pathsWithSpaces.push('History Templates: ' + settings.historyTemplates);
    }
    if (settings.webTemplates && settings.webTemplates.includes(' ')) {
        pathsWithSpaces.push('Web Templates: ' + settings.webTemplates);
    }
    if (settings.zipArchive && settings.zipArchive.includes(' ')) {
        pathsWithSpaces.push('Zip Archive Folder: ' + settings.zipArchive);
    }

    return pathsWithSpaces;
}

async function startPublishProcess(ig, publishSettings) {
    // Check if this IG is already building/publishing
    if (buildProcesses.has(selectedIgIndex)) {
        appendToBuildOutput('Build/publish already in progress for ' + ig.name);
        return;
    }

    // Set timestamp and status
    ig.lastBuildStart = Date.now();

    resetIgConsole(ig, 'IG Publisher - Website Publication');
    appendToIgConsole(ig, 'Starting website publication for ' + ig.name);
    appendToIgConsole(ig, 'Publication mode: go-publish');

    ig.buildStatus = 'Publishing';
    updateIgList();
    updateButtonStates();

    try {
        const appSettings = getCurrentSettings();
        let version = appSettings.igPublisherVersion;
        let downloadUrl = null;

        // Get download URL for the selected version (should be "latest")
        if (version === 'latest') {
            const savedVersions = loadSavedPublisherVersions();
            if (savedVersions && savedVersions.length > 0) {
                version = savedVersions[0].version;
                downloadUrl = savedVersions[0].url;
                appendToIgConsole(ig, 'Using latest version: ' + version);
            } else {
                throw new Error('No publisher versions available. Please check internet connection.');
            }
        } else {
            // This shouldn't happen due to validation, but just in case
            const savedVersions = loadSavedPublisherVersions();
            if (savedVersions) {
                for (let i = 0; i < savedVersions.length; i++) {
                    if (savedVersions[i].version === version) {
                        downloadUrl = savedVersions[i].url;
                        break;
                    }
                }
            }

            if (!downloadUrl) {
                throw new Error('Download URL not found for version ' + version);
            }
        }

        appendToIgConsole(ig, 'IG Publisher version: ' + version);
        appendToIgConsole(ig, 'Memory limit: ' + appSettings.maxMemory + 'GB');

        // Ensure JAR exists (download if necessary)
        const jarPath = await ensureJarExists(version, downloadUrl, ig);

        // Build publication command
        const command = buildPublishCommand(ig, jarPath, publishSettings);
        appendToIgConsole(ig, 'Command: ' + command.join(' '));

        // Start the Java process
        const publishProcess = await runIgPublisherProcess(ig, command);

        // Store the process for stopping if needed
        buildProcesses.set(selectedIgIndex, publishProcess);

    } catch (error) {
        appendToIgConsole(ig, 'Publication setup failed: ' + error.message);
        ig.buildStatus = 'Error';
        updateIgList();
        updateButtonStates();
    }
}

function buildPublishCommand(ig, jarPath, publishSettings) {
    const appSettings = getCurrentSettings();

    const command = ['java'];

    // Add memory setting
    command.push('-Xmx' + appSettings.maxMemory + 'G');

    // Add JAR
    command.push('-jar');
    command.push(jarPath);

    // Add publication-specific parameters
    command.push('-go-publish');
    command.push('-source');
    command.push(ig.folder);
    command.push('-web');
    command.push(publishSettings.websiteFolder);
    command.push('-registry');
    command.push(publishSettings.registryFile);
    command.push('-history');
    command.push(publishSettings.historyTemplates);
    command.push('-templates');
    command.push(publishSettings.webTemplates);
    command.push('-zips');
    command.push(publishSettings.zipArchive);

    // Add terminology server if specified
    if (appSettings.terminologyServer && appSettings.terminologyServer.trim()) {
        command.push('-tx');
        command.push(appSettings.terminologyServer.trim());
    }

    return command;
}

// 10. ADD function to create the dialog HTML
function createPublishDialogHTML(ig, validation, settings) {
    const publicationSummary = createPublicationSummary(validation);
    const validationStatus = createValidationStatus(validation);

    return `
        <div class="dialog-overlay">
            <div class="dialog publication-dialog">
                <div class="dialog-header">Publish "${ig.name}" to Web Site</div>
                <div class="dialog-content publication-content">
                    
                    ${publicationSummary}
                    ${validationStatus}
                    
                    <div class="form-section">
                        <h3>Publication Settings</h3>
                        
                        <div class="form-group-inline">
                            <label for="pub-website-folder">Web Site Folder:</label>
                            <div class="input-with-button">
                                <input type="text" id="pub-website-folder" value="${settings.websiteFolder}" 
                                       placeholder="Folder containing website source for publishing IGs">
                                <button type="button" id="browse-website-folder">Browse...</button>
                            </div>
                        </div>
                        
                        <div class="form-group-inline">
                            <label for="pub-registry-file">Registry File:</label>
                            <div class="input-with-button">
                                <input type="text" id="pub-registry-file" value="${settings.registryFile}" 
                                       placeholder="Full path to fhir-ig-list.json file">
                                <button type="button" id="browse-registry-file">Browse...</button>
                            </div>
                        </div>                        
                        <div class="form-group-inline">
                            <label for="pub-history-templates">History Templates:</label>
                            <div class="input-with-button">
                                <input type="text" id="pub-history-templates" value="${settings.historyTemplates}" 
                                       placeholder="Folder containing history templates">
                                <button type="button" id="browse-history-templates">Browse...</button>
                            </div>
                        </div>
                        
                        <div class="form-group-inline">
                            <label for="pub-web-templates">Web Templates:</label>
                            <div class="input-with-button">
                                <input type="text" id="pub-web-templates" value="${settings.webTemplates}" 
                                       placeholder="Folder containing search page templates">
                                <button type="button" id="browse-web-templates">Browse...</button>
                            </div>
                        </div>
                        
                        <div class="form-group-inline">
                            <label for="pub-zip-archive">Zip Archive Folder:</label>
                            <div class="input-with-button">
                                <input type="text" id="pub-zip-archive" value="${settings.zipArchive}" 
                                       placeholder="Folder where publication archives will be stored">
                                <button type="button" id="browse-zip-archive">Browse...</button>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="dialog-buttons-with-docs">
                    <div class="documentation-links-inline">
                        <span style="font-weight: 500; color: #666;">Documentation:</span>
                        <a href="#" data-url="https://build.fhir.org/ig/ElliotSilver/how-to-publish/publication.html" class="doc-link">Publishing Guide</a>
                        <a href="#" data-url="https://confluence.hl7.org/spaces/FHIR/pages/144970227/IG+Publication+Request+Documentation" class="doc-link">Publication Request Docs</a>
                    </div>
                    <div class="dialog-buttons-right">
                        <button onclick="resolvePublishDialog('cancel')" class="btn-cancel">Cancel</button>
                        <button onclick="resolvePublishDialog('go')" class="btn-go" ${validation.success ? '' : 'disabled'}>Go</button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// 11. ADD function to create publication summary
function createPublicationSummary(validation) {
    if (!validation.publicationRequest) {
        return '<div class="publication-summary"><h3>Publication Request</h3><p>Could not load publication request data.</p></div>';
    }

    const pub = validation.publicationRequest;

    return `
        <div class="publication-summary">
            <h3>Publication Request Summary</h3>
            <div class="publication-info">
                <span class="label">Package:</span>
                <span class="value">${pub.packageId || pub['package-id'] || 'Not specified'}#${pub.version || pub['ig-version'] || 'Not specified'} in Sequence ${pub.sequence || 'Not specified'}</span>
                <span class="label">Publish:</span>
                <span class="value">as ${pub.status || 'Not specified'}/${pub.mode || 'Not specified'} to ${pub.path || 'Not specified'}</span>
                <span class="label">Description:</span>
                <span class="value">${pub.desc || pub.descmd || 'Not specified'}</span>
            </div>
        </div>
    `;
}

// 12. ADD function to create validation status
function createValidationStatus(validation) {
    const statusClass = validation.success ? 'validation-success' :
      validation.messages.some(m => m.startsWith('✗')) ? 'validation-error' : 'validation-warning';

    const messages = validation.messages.map(msg => `<div>${msg}</div>`).join('');

    return `
        <div class="validation-status ${statusClass}">
            <strong>Validation Status:</strong>
            ${messages}
        </div>
    `;
}

// 13. ADD function to setup dialog event listeners
function setupPublishDialogListeners(dialog) {
    // Browse buttons - ALL use 'select-folder' since that's what's available
    const browseButtons = [
        { id: 'browse-website-folder', inputId: 'pub-website-folder' },
        { id: 'browse-registry-file', inputId: 'pub-registry-file' },
        { id: 'browse-history-templates', inputId: 'pub-history-templates' },
        { id: 'browse-web-templates', inputId: 'pub-web-templates' },
        { id: 'browse-zip-archive', inputId: 'pub-zip-archive' }
    ];

    browseButtons.forEach(button => {
        const btn = dialog.querySelector('#' + button.id);
        const input = dialog.querySelector('#' + button.inputId);

        if (btn && input) {
            btn.addEventListener('click', async function() {
                try {
                    // Use select-folder for all selections
                    const result = await ipcRenderer.invoke('select-folder');

                    if (!result.canceled && result.filePaths.length > 0) {
                        const selectedPath = result.filePaths[0];

                        // For registry file, append the expected filename if it exists
                        if (button.id === 'browse-registry-file') {
                            const registryPath = path.join(selectedPath, 'fhir-ig-list.json');
                            if (fs.existsSync(registryPath)) {
                                input.value = registryPath;
                            } else {
                                // Let user specify the full path manually
                                input.value = selectedPath;
                                // Show a helpful message
                                setTimeout(() => {
                                    alert('fhir-ig-list.json not found in selected folder.\nPlease manually add the filename to the path.');
                                }, 100);
                            }
                        } else {
                            input.value = selectedPath;
                        }
                    }
                } catch (error) {
                    console.log('Error selecting folder:', error);
                    appendToBuildOutput('Error selecting folder: ' + error.message);
                }
            });
        }
    });

    // Documentation links
    const docLinks = dialog.querySelectorAll('.doc-link');
    docLinks.forEach(link => {
        link.addEventListener('click', async function(e) {
            e.preventDefault();
            const url = this.getAttribute('data-url');
            if (url) {
                try {
                    await ipcRenderer.invoke('open-external', url);
                } catch (error) {
                    console.log('Failed to open documentation:', error);
                }
            }
        });
    });
}