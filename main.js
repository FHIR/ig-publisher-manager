/*
BSD 3-Clause License

Copyright (c) 2025, Grahame Grieve
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');

function createWindow() {

  // Debug the icon path
  const iconPath = path.join(__dirname, 'assets/icon.png');
  console.log('Icon path:', iconPath);
  console.log('Icon exists:', require('fs').existsSync(iconPath));

  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    icon: path.join(__dirname, 'assets/icon.png'), // Add your icon here
    title: `IG Publisher Manager (v${app.getVersion()})`
  });

  mainWindow.loadFile('index.html');

  // Set up menu
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Add Folder...',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow.webContents.send('menu-add-folder')
        },
        {
          label: 'Add from Git Server...',
          accelerator: 'CmdOrCtrl+G',
          click: () => mainWindow.webContents.send('menu-add-github')
        },
        { type: 'separator' },
        {
          label: 'Search in Files...',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => mainWindow.webContents.send('menu-search')
        },
        { type: 'separator' },
        {
          label: 'Exit',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => app.quit()
        }
      ]
    },
    {
      label: 'Build',
      submenu: [
        {
          label: 'Build Selected',
          accelerator: 'F5',
          click: () => mainWindow.webContents.send('menu-build')
        },
        {
          label: 'Clear TX Cache',
          click: () => mainWindow.webContents.send('menu-clear-cache')
        }
      ]
    },
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Update Publisher',
          click: () => mainWindow.webContents.send('menu-update')
        },
        {
          label: 'Update + Stash',
          click: () => mainWindow.webContents.send('menu-update-stash')
        },
        { type: 'separator' },
        {
          label: 'Developer Tools',
          accelerator: 'F12',
          click: () => mainWindow.webContents.openDevTools()
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // Handle getting user data path for storing JAR files
  ipcMain.handle('get-user-data-path', async () => {
    return app.getPath('userData');
  });

  // Handle folder selection
  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select IG Folder'
    });
    return result;
  });

  // Handle file selection
  ipcMain.handle('select-file', async (event, options) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: options.properties || ['openFile'],
      filters: options.filters || [],
      title: options.title || 'Select File'
    });
    return result;
  });

  // Handle file operations
  ipcMain.handle('show-item-in-folder', async (event, folderPath) => {
    const { shell } = require('electron');
    shell.showItemInFolder(folderPath);
  });

  ipcMain.handle('open-external', async (event, url) => {
    const { shell } = require('electron');
    shell.openExternal(url);
  });

  // Handle terminal opening
  ipcMain.handle('open-terminal', async (event, folderPath) => {
    const { spawn } = require('child_process');
    const os = require('os');
    
    try {
      const platform = os.platform();
      
      if (platform === 'darwin') {
        // macOS - open Terminal
        spawn('open', ['-a', 'Terminal', folderPath]);
      } else if (platform === 'win32') {
        // Windows - open Command Prompt
        spawn('cmd', ['/c', 'start', 'cmd'], { cwd: folderPath });
      } else {
        // Linux - try to open default terminal
        spawn('gnome-terminal', ['--working-directory', folderPath]);
      }
      
      return { success: true };
    } catch (error) {
      throw new Error(`Failed to open terminal: ${error.message}`);
    }
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

// Handle folder deletion
ipcMain.handle('delete-folder', async (event, folderPath) => {
  const fs = require('fs').promises;
  const path = require('path');

  try {
    // Validate the path exists and is a directory
    const stats = await fs.stat(folderPath);
    if (!stats.isDirectory()) {
      throw new Error('Path is not a directory');
    }

    // Use the modern fs.rm method with recursive option
    await fs.rm(folderPath, {
      recursive: true,
      force: true
    });

    return { success: true };
  } catch (error) {
    throw new Error(`Failed to delete folder: ${error.message}`);
  }
});


// Handle getting FHIR settings file path
ipcMain.handle('get-fhir-settings-path', async () => {
  const os = require('os');
  const path = require('path');

  const homeDir = os.homedir();
  const settingsPath = path.join(homeDir, '.fhir', 'fhir-settings.json');

  return settingsPath;
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});