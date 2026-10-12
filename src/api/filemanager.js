import { NativeModules, PermissionsAndroid } from 'react-native';

const FileManager = NativeModules.FileManager;

async function requestStoragePermission() {
  try {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
      {
        title: '存储权限',
        message: 'Listen1 需要存储权限用于备份文件的写入和读取',
        buttonPositive: '允许',
        buttonNegative: '拒绝',
      }
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  } catch (e) {
    return false;
  }
}

// Write a backup file; resolves with the absolute path that was written.
export async function writeBackupFile(fileName, content) {
  await requestStoragePermission();
  return FileManager.writeFile(fileName, content);
}

// Resolve with [{name, path, size, mtime}] sorted by mtime desc.
export function listBackupFiles() {
  return FileManager.listBackupFiles().then(arr => arr || []);
}

export function readBackupFile(path) {
  return FileManager.readFile(path);
}
