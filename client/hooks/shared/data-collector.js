#!/usr/bin/env node

// 数据收集工具模块 - 共享给所有Hook版本使用
// 避免代码重复，遵循DRY原则

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { homedir } from 'node:os';
import crypto from 'node:crypto';

// 获取用户主目录和 Claude 配置目录
const USER_HOME_DIR = homedir();
const XDG_CONFIG_DIR = process.env.XDG_CONFIG_HOME ?? `${USER_HOME_DIR}/.config`;
const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
const CLAUDE_PROJECTS_DIR = 'projects';
const RETENTION_DAYS = 30;

// 获取 Claude 配置路径
function getClaudePaths() {
  const envPaths = process.env[CLAUDE_CONFIG_DIR_ENV];
  const paths = envPaths 
    ? envPaths.split(',')
    : [`${XDG_CONFIG_DIR}/claude`, `${USER_HOME_DIR}/.claude`];
  
  return paths.filter(p => existsSync(path.join(p, CLAUDE_PROJECTS_DIR)));
}

// 递归查找 JSONL 文件
async function findJsonlFiles(dir) {
  const files = [];
  
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        files.push(...await findJsonlFiles(fullPath));
      } else if (entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  } catch {
    // 静默忽略错误
  }
  
  return files;
}

// 解析使用数据
function parseUsageFromLine(line) {
  try {
    const data = JSON.parse(line.trim());
    
    // 验证必需字段
    if (!data?.timestamp || !data?.message?.usage) return null;
    
    const usage = data.message.usage;
    if (typeof usage.input_tokens !== 'number' || 
        typeof usage.output_tokens !== 'number') return null;
    
    // 生成交互哈希用于去重
    const hashInput = `${data.timestamp}${data.message?.id || ''}${data.requestId || ''}`;
    const interactionHash = crypto.createHash('sha256').update(hashInput).digest('hex');
    
    return {
      timestamp: data.timestamp,
      tokens: {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cache_creation: usage.cache_creation_input_tokens || 0,
        cache_read: usage.cache_read_input_tokens || 0
      },
      model: data.message.model || 'unknown',
      session_id: data.sessionId || null,
      interaction_hash: interactionHash
    };
  } catch {
    return null;
  }
}

// 解析单个JSONL文件
async function parseJsonlFile(filePath, state, logger) {
  const entries = [];
  
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);
    
    const entryRetentionMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const line of lines) {
      const entry = parseUsageFromLine(line);
      if (!entry) continue;

      // 跳过 30 天前的记录（state 不再持有其哈希，无法去重，也无需重传）
      const entryTime = new Date(entry.timestamp).getTime();
      if (isNaN(entryTime) || now - entryTime > entryRetentionMs) continue;

      // 检查是否已处理过（基于哈希去重）
      const dayKey = entry.timestamp.split('T')[0]; // YYYY-MM-DD
      if (state.recentHashes[dayKey]?.includes(entry.interaction_hash)) {
        continue; // 跳过已处理的记录
      }

      entries.push(entry);
    }
    
    if (entries.length > 0 && logger) {
      await logger.log('debug', 'Parsed JSONL file', {
        file: path.basename(filePath),
        totalLines: lines.length,
        validEntries: entries.length
      });
    }
  } catch (error) {
    if (logger) {
      await logger.log('warn', 'Failed to parse JSONL file', {
        file: filePath,
        error: error.message
      });
    }
  }
  
  return entries;
}

// 收集新的使用数据
async function collectNewUsageData(state, logger) {
  const claudePaths = getClaudePaths();
  if (claudePaths.length === 0) {
    if (logger) await logger.log('warn', 'No Claude config directories found');
    return [];
  }
  
  const allEntries = [];
  
  if (logger) await logger.log('info', 'Starting data collection', {
    claudePaths: claudePaths.length
  });
  
  for (const claudePath of claudePaths) {
    const projectsDir = path.join(claudePath, CLAUDE_PROJECTS_DIR);
    
    try {
      const allJsonlFiles = await findJsonlFiles(projectsDir);
      const cutoffTime = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const jsonlFiles = [];
      for (const file of allJsonlFiles) {
        try {
          const fileStat = await stat(file);
          if (fileStat.mtimeMs >= cutoffTime) jsonlFiles.push(file);
        } catch { /* skip unreadable files */ }
      }
      if (logger) await logger.log('debug', 'Found JSONL files', {
        path: projectsDir,
        total: allJsonlFiles.length,
        recent: jsonlFiles.length
      });

      for (const file of jsonlFiles) {
        const entries = await parseJsonlFile(file, state, logger);
        allEntries.push(...entries);
      }
    } catch (error) {
      if (logger) await logger.log('warn', 'Failed to scan directory', {
        directory: projectsDir,
        error: error.message
      });
    }
  }
  
  if (logger) {
    if (allEntries.length > 0) {
      await logger.log('info', 'Data collection completed', {
        newEntries: allEntries.length
      });
    } else {
      await logger.log('info', 'No new entries found');
    }
  }
  
  return allEntries;
}

export { 
  getClaudePaths, 
  findJsonlFiles, 
  parseUsageFromLine, 
  parseJsonlFile,
  collectNewUsageData 
};