# IG Publisher Manager

A desktop application for managing FHIR Implementation Guide publishing workflows. Built with Electron, this tool provides a graphical interface for building, testing, and managing multiple FHIR Implementation Guides.

## FHIR Foundation Project Statement

* Maintainers: Grahame Grieve (looking for volunteers)
* Issues / Discussion: https://github.com/FHIR/ig-publisher-manager/issues / https://chat.fhir.org/#narrow/channel/196008-ig-publishing-requirements
* License: BSD-3
* Contribution Policy: See [Contributing](#contributing).
* Security Information: To report a security issue, please use the GitHub Security Advisory ["Report a Vulnerability"](https://github.com/FHIR/ig-publisher-manager/security/advisories/new) tab.

## Contributing

There are many ways to contribute:
* [Submit bugs](https://github.com/FHIR/ig-publisher-manager/issues) and help us verify fixes as they are checked in.
* Review the [source code changes](https://github.com/FHIR/ig-publisher-manager/pulls).
* Engage with users and developers on the [IG Publishing Stream on FHIR Zulip](https://chat.fhir.org/#narrow/channel/196008-ig-publishing-requirements)
* Contribute features or bug fixes via PRs:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request


## Features

### 📁 **Project Management**
- Add IG projects from local folders
- Clone IG projects directly from GitHub repositories  
- Automatic detection of IG metadata from FHIR resources or SUSHI configs
- Persistent project list with build status tracking

### 🔨 **Build & Publishing**
- One-click IG Publisher builds with real-time console output
- Configurable build options (memory limits, terminology servers, validation flags)
- Support for multiple IG Publisher versions
- Build process cancellation and status tracking
- Jekyll build support for custom processing

### 🌐 **Quick Access**
- Direct links to built IG output and QA reports
- Open project folders in system file manager
- Launch terminal sessions in project directories
- Copy project paths, GitHub URLs, and package IDs

### 🔄 **Git Integration**
- Update source code with smart git operations (pull, stash+pull+pop, reset+pull)
- Support for GitHub repository cloning with branch selection
- Automatic GitHub URL detection from clipboard
- Git repository status detection

### 🛠️ **Developer Tools**
- Clear terminology cache (TxCache)
- Run standalone Jekyll builds
- Access FHIR global settings file
- Build log management with copy/clear functionality

### ⚙️ **Advanced Configuration**
- Configurable IG Publisher versions with automatic updates
- Custom terminology server settings
- Memory allocation controls
- Build flags (no-narrative, no-validation, no-network, no-sushi, debugging)
- Resizable interface panels with persistence

## Requirements

- **Node.js** 16.x or later
- **Java** 11 or later (for IG Publisher)
- **Git** (for repository operations)
- **Jekyll** (optional, for Jekyll builds)

### Platform Support
- macOS 10.14+
- Windows 10+
- Linux (Ubuntu 18.04+, other distributions)

## Installation

### Download Release (Recommended)
1. Visit the [Releases page](https://github.com/YOUR_USERNAME/ig-publisher-manager/releases)
2. Download the appropriate installer for your platform:
   - **macOS**: `.dmg` file
   - **Windows**: `.exe` installer or portable `.exe`
   - **Linux**: `.AppImage`, `.deb`, or `.rpm`

Note that the releases are not signed - setting up signing with EV certificates is tiresome 
now that you need a physical key. On OSX, you'll have to do go to your security settings 
and allow the IG Publisher Manager to run. if you trust GitHub and the build scripts and so
forth.

### Build from Source
```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/ig-publisher-manager.git
cd ig-publisher-manager

# Install dependencies
npm install

# Run in development mode
npm start

# Build for your platform
npm run build

# Build for all platforms
npm run build-all
```

## Quick Start

1. **Launch the application**
2. **Add your first IG**:
   - Click "Add Folder" to add an existing IG project
   - Or click "Add from GitHub" to clone a repository
3. **Configure build options** (click the arrow button in toolbar to expand options)
4. **Select an IG** from the list and click "Build" 
5. **Monitor progress** in the build output panel
6. **Open results** using "Open IG" or "Open QA" buttons

## Usage Guide

### Adding Implementation Guides

#### From Local Folder
1. Click the "Add Folder" button in the toolbar
2. Select a folder containing an IG project (must have `ig.ini` file)
3. The IG will be automatically detected and added to the list

#### From GitHub
1. Click "Add from GitHub" button
2. Fill in the organization, repository, and branch
3. Or paste a GitHub URL and click "Paste from Clipboard" to auto-populate
4. Choose a local base folder for cloning
5. Click "Clone Repository"

### Building Implementation Guides

1. **Select an IG** from the list
2. **Configure options** (expand the options panel):
   - Set terminology server URL
   - Choose IG Publisher version  
   - Adjust memory allocation
   - Enable/disable build flags
3. **Click "Build"** or press F5
4. **Monitor progress** in the build output panel
5. **Stop if needed** using the "Stop" button

### Managing Projects

#### Context Menu (Right-click on any IG)
- **Start Build** / **Stop Build**
- **Open IG** - View the built implementation guide
- **Open QA** - View the quality assurance report
- **Copy Path** - Copy project folder path to clipboard
- **Copy GitHub URL** - Copy repository URL to clipboard
- **Update** - Git pull operations (for git repositories)
- **Open Folder** - Open in system file manager
- **Open Terminal** - Launch terminal in project directory

#### Developer Tools Menu
- **Clear TxCache** - Clear terminology cache
- **Open Terminal Here** - Launch terminal in project folder
- **Run Jekyll** - Run Jekyll build on generated pages
- **Open Settings File** - Edit FHIR global settings

### Git Operations

For Git repositories, use the "Update" button to:
- **Just Pull** - Simple git pull
- **Reset & Pull** - Hard reset then pull (discards local changes)
- **Stash, Pull, Pop** - Preserve local changes while updating

## Configuration

### IG Publisher Settings
Settings are automatically saved and include:
- Terminology server URL
- IG Publisher version preference
- Memory allocation (1-32 GB)
- Build flags (narrative, validation, network, SUSHI, debugging)

### Project Data
- Project list is automatically saved to local storage
- Panel sizes and layout preferences are preserved
- Build logs are maintained per-project during the session

## File Structure

The application expects IG projects to have:
- **`ig.ini`** - IG Publisher configuration file
- **IG Resource** - JSON or XML ImplementationGuide resource (path specified in ig.ini)
- **OR `sushi-config.yaml`** - SUSHI configuration (fallback for projects without IG resource)

## Building & Distribution

### Development
```bash
npm start          # Run in development mode
npm run dev        # Run with verbose logging
```

### Building
```bash
npm run build      # Build for current platform
npm run build-mac  # Build for macOS
npm run build-win  # Build for Windows  
npm run build-linux # Build for Linux
npm run build-all  # Build for all platforms
```

Built applications will be in the `dist/` folder.

## Troubleshooting

### Common Issues

**Java not found**
- Install Java 11+ and ensure it's in your PATH
- Test with `java -version` in terminal

**Git operations fail**
- Ensure Git is installed and in your PATH
- Check repository permissions and authentication

**Build fails**
- Check that `ig.ini` exists and is properly formatted
- Verify IG resource file path in `ig.ini`
- Ensure sufficient memory allocation in settings

**Icons not showing**
- Try clearing system icon cache (platform-specific instructions)
- Restart the application

### Debug Information
Enable debug logging by running:
```bash
npm run dev
```

Check the console output for detailed error information.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Setup
```bash
git clone https://github.com/YOUR_USERNAME/ig-publisher-manager.git
cd ig-publisher-manager
npm install
npm start
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Related Projects

- [FHIR IG Publisher](https://github.com/HL7/fhir-ig-publisher) - The core IG publishing tool
- [SUSHI](https://github.com/FHIR/sushi) - FSH (FHIR Shorthand) compiler
- [HL7 FHIR](https://www.hl7.org/fhir/) - Fast Healthcare Interoperability Resources

## Support

- **Issues**: [GitHub Issues](https://github.com/YOUR_USERNAME/ig-publisher-manager/issues)
- **Discussions**: [GitHub Discussions](https://github.com/YOUR_USERNAME/ig-publisher-manager/discussions)
- **FHIR Chat**: [Zulip IG Publisher stream](https://chat.fhir.org/#narrow/stream/179252-IG-creation)

---

**Made with ❤️ for the FHIR community**