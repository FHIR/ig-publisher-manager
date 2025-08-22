// Fixed search.js with corrected search logic

class IGSearch {
  constructor() {
    this.maxResults = 200;
    this.searchStates = new Map(); // Per-IG search state storage
  }

  // Get or create search state for an IG
  getSearchState(igFolder) {
    if (!this.searchStates.has(igFolder)) {
      this.searchStates.set(igFolder, {
        searchTerm: '',
        caseSensitive: false,
        wholeWords: false,
        categories: {
          fsh: true,
          inputResources: true,
          inputPages: true,
          translations: true,
          outputResources: false,
          outputHtml: false
        },
        results: [],
        lastSearchTime: null
      });
    }
    return this.searchStates.get(igFolder);
  }

  // Save search state for an IG
  saveSearchState(igFolder, state) {
    this.searchStates.set(igFolder, state);
  }

  // Clear output results when build starts
  clearOutputResults(igFolder) {
    const state = this.getSearchState(igFolder);
    state.results = state.results.filter(result =>
      !result.category.startsWith('output')
    );
    this.saveSearchState(igFolder, state);
  }

  // Check if categories should be enabled
  getCategoryAvailability(igFolder) {
    const availability = {
      fsh: false,
      inputResources: true,
      inputPages: true,
      translations: true,
      outputResources: false,
      outputHtml: false
    };

    try {
      // Check for FSH (sushi-config.yaml)
      const sushiConfigPath = require('path').join(igFolder, 'sushi-config.yaml');
      availability.fsh = require('fs').existsSync(sushiConfigPath);

      // Check for output (has been built)
      const outputPath = require('path').join(igFolder, 'output');
      if (require('fs').existsSync(outputPath)) {
        const outputStats = require('fs').statSync(outputPath);
        if (outputStats.isDirectory()) {
          availability.outputResources = true;
          availability.outputHtml = true;
        }
      }
    } catch (error) {
      console.log('Error checking category availability:', error);
    }

    return availability;
  }

  // Main search function - FIXED the category filtering bug
  async performSearch(igFolder, searchTerm, options = {}) {
    const {
      caseSensitive = false,
      wholeWords = false,
      categories = {}
    } = options;

    if (!searchTerm || !searchTerm.trim()) {
      return { results: [], totalMatches: 0, error: null };
    }

    console.log('Performing search with categories:', categories);

    const results = [];
    let totalMatches = 0;

    try {
      // Create search pattern
      const pattern = this.createSearchPattern(searchTerm, caseSensitive, wholeWords);

      // Search each enabled category - FIX: Only search categories that are actually enabled
      for (const [categoryName, enabled] of Object.entries(categories)) {
        if (!enabled) {
          console.log(`Skipping category ${categoryName} - not enabled`);
          continue;
        }

        if (totalMatches >= this.maxResults) {
          console.log('Reached max results, stopping search');
          break;
        }

        console.log(`Searching category: ${categoryName}`);
        const categoryResults = await this.searchCategory(
          igFolder,
          categoryName,
          pattern,
          this.maxResults - totalMatches
        );

        console.log(`Found ${categoryResults.length} files in category ${categoryName}`);
        results.push(...categoryResults);
        totalMatches += categoryResults.reduce((sum, result) => sum + result.matches.length, 0);
      }

      // Sort results by relevance
      results.sort((a, b) => {
        // Prioritize by file name matches, then by number of matches
        const aFileMatch = pattern.test(require('path').basename(a.filePath));
        const bFileMatch = pattern.test(require('path').basename(b.filePath));

        if (aFileMatch && !bFileMatch) return -1;
        if (!aFileMatch && bFileMatch) return 1;

        return b.matches.length - a.matches.length;
      });

      console.log(`Search completed: ${results.length} files, ${totalMatches} total matches`);

      return {
        results: results.slice(0, this.maxResults),
        totalMatches: totalMatches,
        error: null,
        truncated: totalMatches > this.maxResults
      };

    } catch (error) {
      console.error('Search error:', error);
      return {
        results: [],
        totalMatches: 0,
        error: error.message
      };
    }
  }

  // Create search regex pattern
  createSearchPattern(searchTerm, caseSensitive, wholeWords) {
    let escapedTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (wholeWords) {
      escapedTerm = `\\b${escapedTerm}\\b`;
    }

    const flags = caseSensitive ? 'g' : 'gi';
    return new RegExp(escapedTerm, flags);
  }

  // Search within a specific category
  async searchCategory(igFolder, categoryName, pattern, maxResults) {
    const searchPaths = this.getCategoryPaths(igFolder, categoryName);
    const results = [];

    console.log(`Searching ${searchPaths.length} paths for category ${categoryName}`);

    for (const searchConfig of searchPaths) {
      if (results.length >= maxResults) break;

      if (!require('fs').existsSync(searchConfig.path)) {
        console.log(`Path does not exist: ${searchConfig.path}`);
        continue;
      }

      console.log(`Searching path: ${searchConfig.path}`);
      const files = this.findFilesInPath(searchConfig.path, searchConfig.extensions, searchConfig.recursive);
      console.log(`Found ${files.length} files in ${searchConfig.path}`);

      for (const filePath of files) {
        if (results.length >= maxResults) break;

        if (searchConfig.filter && !searchConfig.filter(filePath)) {
          continue;
        }

        const fileResults = await this.searchInFile(filePath, pattern, categoryName);
        if (fileResults) {
          results.push(fileResults);
        }
      }
    }

    console.log(`Category ${categoryName} search complete: ${results.length} files with matches`);
    return results;
  }

  // Get file paths for each category - FIXED the category mappings
  getCategoryPaths(igFolder, categoryName) {
    const paths = [];

    switch (categoryName) {
      case 'fsh':
        paths.push({
          path: igFolder,
          extensions: ['.yaml'],
          recursive: false,
          filter: (filePath) => require('path').basename(filePath) === 'sushi-config.yaml'
        });
        paths.push({
          path: require('path').join(igFolder, 'input'),
          extensions: ['.fsh'],
          recursive: true
        });
        break;

      case 'inputResources':
        paths.push({
          path: require('path').join(igFolder, 'input'),
          extensions: ['.json', '.xml', '.map', '.ttl'],
          recursive: true,
          filter: (filePath) => this.isResourceFile(filePath)
        });

        // Only add fsh-generated if it exists
        const fshGeneratedPath = require('path').join(igFolder, 'fsh-generated');
        if (require('fs').existsSync(fshGeneratedPath)) {
          paths.push({
            path: fshGeneratedPath,
            extensions: ['.json', '.xml', '.map', '.ttl'],
            recursive: true,
            filter: (filePath) => this.isResourceFile(filePath)
          });
        }
        break;

      case 'inputPages':
        paths.push({
          path: require('path').join(igFolder, 'input', 'pagecontent'),
          extensions: [], // All files
          recursive: true
        });
        break;

      case 'translations':
        paths.push({
          path: require('path').join(igFolder, 'input', 'translations'),
          extensions: [], // All text files
          recursive: true,
          filter: (filePath) => this.isTextFile(filePath)
        });
        break;

      case 'outputResources':
        paths.push({
          path: require('path').join(igFolder, 'output'),
          extensions: ['.json'],
          recursive: true,
          filter: (filePath) => this.isResourceFile(filePath)
        });
        break;

      case 'outputHtml':
        paths.push({
          path: require('path').join(igFolder, 'output'),
          extensions: ['.html'],
          recursive: true
        });
        break;
    }

    // Only return paths that actually exist
    const existingPaths = paths.filter(pathConfig => require('fs').existsSync(pathConfig.path));
    console.log(`Category ${categoryName}: ${paths.length} configured paths, ${existingPaths.length} existing paths`);
    return existingPaths;
  }

  // Find files matching criteria
  findFilesInPath(dirPath, extensions, recursive) {
    const files = [];

    if (!require('fs').existsSync(dirPath)) {
      return files;
    }

    try {
      const items = require('fs').readdirSync(dirPath);

      for (const item of items) {
        const fullPath = require('path').join(dirPath, item);
        let stat;

        try {
          stat = require('fs').statSync(fullPath);
        } catch (error) {
          // Skip files we can't stat (permissions, etc.)
          continue;
        }

        if (stat.isFile()) {
          const ext = require('path').extname(item).toLowerCase();

          if (extensions.length === 0 || extensions.includes(ext)) {
            files.push(fullPath);
          }
        } else if (stat.isDirectory() && recursive) {
          // Skip common non-source directories
          if (!this.shouldSkipDirectory(item)) {
            files.push(...this.findFilesInPath(fullPath, extensions, recursive));
          }
        }
      }
    } catch (error) {
      console.log(`Error reading directory ${dirPath}:`, error);
    }

    return files;
  }

  // Check if directory should be skipped
  shouldSkipDirectory(dirName) {
    const skipDirs = [
      'node_modules', '.git', '.svn', '.hg',
      'temp', 'input-cache', 'txcache',
      'bin', 'obj', 'target', 'build', 'dist',
      '.vs', '.vscode', '.idea'
    ];
    return skipDirs.includes(dirName.toLowerCase());
  }

  // Check if file is a FHIR resource file - IMPROVED detection
  isResourceFile(filePath) {
    try {
      const ext = require('path').extname(filePath).toLowerCase();

      if (ext === '.json') {
        const content = require('fs').readFileSync(filePath, 'utf8');
        // Check for resourceType in the first part of the file
        const sample = content.substring(0, Math.min(2000, content.length));
        return sample.includes('"resourceType"');
      } else if (ext === '.xml') {
        const content = require('fs').readFileSync(filePath, 'utf8');
        // Check for FHIR namespace in the first part of the file
        const sample = content.substring(0, Math.min(2000, content.length));
        return sample.includes('xmlns="http://hl7.org/fhir"') ||
          sample.includes('http://hl7.org/fhir');
      } else if (ext === '.map' || ext === '.ttl') {
        return true; // These are typically FHIR-related
      }
    } catch (error) {
      // If we can't read the file, skip it
      console.log(`Could not read file ${filePath}:`, error);
      return false;
    }

    return false;
  }

  // Check if file is a text file
  isTextFile(filePath) {
    try {
      const ext = require('path').extname(filePath).toLowerCase();
      const textExtensions = ['.txt', '.md', '.json', '.xml', '.html', '.css', '.js', '.yaml', '.yml', '.properties'];

      if (textExtensions.includes(ext)) {
        return true;
      }

      // For files without extensions or unknown extensions, check content
      const buffer = require('fs').readFileSync(filePath, { encoding: null });
      const sample = buffer.slice(0, Math.min(512, buffer.length));

      // Check for null bytes (binary indicator)
      for (let i = 0; i < sample.length; i++) {
        if (sample[i] === 0) {
          return false;
        }
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  // Search within a single file
  async searchInFile(filePath, pattern, category) {
    try {
      const content = require('fs').readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      const matches = [];

      for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        const lineMatches = [...line.matchAll(pattern)];

        if (lineMatches.length > 0) {
          matches.push({
            lineNumber: lineNum + 1,
            line: line.trim(),
            matchCount: lineMatches.length
          });
        }
      }

      if (matches.length > 0) {
        return {
          filePath: filePath,
          fileName: require('path').basename(filePath),
          relativePath: this.getRelativePath(filePath),
          category: category,
          matches: matches,
          totalMatches: matches.reduce((sum, match) => sum + match.matchCount, 0)
        };
      }

      return null;
    } catch (error) {
      console.log(`Error searching file ${filePath}:`, error);
      return null;
    }
  }

  // Get relative path for display
  getRelativePath(filePath) {
    if (this.currentIgFolder && filePath.startsWith(this.currentIgFolder)) {
      return require('path').relative(this.currentIgFolder, filePath);
    }
    return require('path').basename(filePath);
  }

  // Set current IG folder for relative path calculation
  setCurrentIgFolder(igFolder) {
    this.currentIgFolder = igFolder;
  }
}

// Make it available globally
window.IGSearch = IGSearch;