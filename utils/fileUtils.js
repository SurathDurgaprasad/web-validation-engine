const fs = require('fs-extra');
const path = require('path');

class FileUtils {
  static async ensureDirectory(dirPath) {
    await fs.ensureDir(dirPath);
  }

  static async writeJsonFile(filePath, data) {
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeJson(filePath, data, { spaces: 2 });
  }

  static async readJsonFile(filePath) {
    return await fs.readJson(filePath);
  }

  static async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  static async writeTextFile(filePath, content) {
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content, 'utf8');
  }

  static async readTextFile(filePath) {
    return await fs.readFile(filePath, 'utf8');
  }

  static async copyFile(src, dest) {
    await fs.ensureDir(path.dirname(dest));
    await fs.copyFile(src, dest);
  }

  static async deleteFile(filePath) {
    if (await this.fileExists(filePath)) {
      await fs.unlink(filePath);
    }
  }

  static async listFiles(dirPath) {
    return await fs.readdir(dirPath);
  }

  static async getFileStats(filePath) {
    return await fs.stat(filePath);
  }

  static getRelativePath(from, to) {
    return path.relative(from, to);
  }

  static resolvePath(...paths) {
    return path.resolve(...paths);
  }

  static getFileExtension(filePath) {
    return path.extname(filePath);
  }

  static getFileName(filePath) {
    return path.basename(filePath);
  }

  static getDirectoryName(filePath) {
    return path.dirname(filePath);
  }

  static sanitizeFileName(name) {
    return name.replace(/[^a-zA-Z0-9\-_\.]/g, '_');
  }

  static generateTimestampedFileName(baseName, extension = '') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${baseName}_${timestamp}${extension}`;
  }

  static async cleanDirectory(dirPath) {
    await fs.emptyDir(dirPath);
  }

  static async removeDirectory(dirPath) {
    await fs.remove(dirPath);
  }

  static async getDirectorySize(dirPath) {
    let totalSize = 0;

    async function calculateSize(itemPath) {
      const stats = await fs.stat(itemPath);

      if (stats.isDirectory()) {
        const items = await fs.readdir(itemPath);
        for (const item of items) {
          await calculateSize(path.join(itemPath, item));
        }
      } else {
        totalSize += stats.size;
      }
    }

    await calculateSize(dirPath);
    return totalSize;
  }
}

module.exports = FileUtils;