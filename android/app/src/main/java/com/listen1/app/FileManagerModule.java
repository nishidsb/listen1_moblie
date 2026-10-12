package com.listen1.app;

import android.os.Environment;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Locale;

/**
 * File-based backup/restore support: write JSON backups to the public
 * Download dir when possible (falls back to the app external files dir),
 * list candidate backup files, and read one back as UTF-8 text.
 */
public class FileManagerModule extends ReactContextBaseJavaModule {

    public FileManagerModule(ReactApplicationContext context) {
        super(context);
    }

    @Override
    public String getName() {
        return "FileManager";
    }

    @ReactMethod
    public void writeFile(final String fileName, final String content, final Promise promise) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    File target = null;
                    try {
                        File download = Environment.getExternalStoragePublicDirectory(
                                Environment.DIRECTORY_DOWNLOADS);
                        if (download != null) {
                            if (!download.exists()) {
                                download.mkdirs();
                            }
                            if (download.isDirectory()) {
                                File f = new File(download, fileName);
                                writeText(f, content);
                                target = f;
                            }
                        }
                    } catch (Exception ignored) {
                        target = null;
                    }
                    if (target == null) {
                        File appDir = getReactApplicationContext().getExternalFilesDir(null);
                        if (appDir == null) {
                            appDir = getReactApplicationContext().getFilesDir();
                        }
                        if (!appDir.exists()) {
                            appDir.mkdirs();
                        }
                        File f = new File(appDir, fileName);
                        writeText(f, content);
                        target = f;
                    }
                    promise.resolve(target.getAbsolutePath());
                } catch (Exception e) {
                    promise.reject("WRITE_FAILED", e);
                }
            }
        }).start();
    }

    @ReactMethod
    public void listBackupFiles(final Promise promise) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    WritableArray arr = Arguments.createArray();
                    File download = Environment.getExternalStoragePublicDirectory(
                            Environment.DIRECTORY_DOWNLOADS);
                    listDir(download, arr);
                    File appDir = getReactApplicationContext().getExternalFilesDir(null);
                    listDir(appDir, arr);
                    promise.resolve(arr);
                } catch (Exception e) {
                    promise.reject("LIST_FAILED", e);
                }
            }
        }).start();
    }

    @ReactMethod
    public void readFile(final String path, final Promise promise) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                FileInputStream in = null;
                try {
                    File f = new File(path);
                    byte[] bytes = new byte[(int) f.length()];
                    in = new FileInputStream(f);
                    int off = 0;
                    while (off < bytes.length) {
                        int n = in.read(bytes, off, bytes.length - off);
                        if (n < 0) {
                            break;
                        }
                        off += n;
                    }
                    promise.resolve(new String(bytes, "UTF-8"));
                } catch (Exception e) {
                    promise.reject("READ_FAILED", e);
                } finally {
                    if (in != null) {
                        try {
                            in.close();
                        } catch (Exception ignored) {
                        }
                    }
                }
            }
        }).start();
    }

    private static void writeText(File f, String content) throws Exception {
        OutputStreamWriter w = null;
        try {
            w = new OutputStreamWriter(new FileOutputStream(f), "UTF-8");
            w.write(content);
        } finally {
            if (w != null) {
                w.close();
            }
        }
    }

    private static void listDir(File dir, WritableArray out) {
        File[] files = dir == null ? null : dir.listFiles();
        if (files == null) {
            return;
        }
        Arrays.sort(files, new Comparator<File>() {
            @Override
            public int compare(File a, File b) {
                return Long.valueOf(b.lastModified()).compareTo(a.lastModified());
            }
        });
        for (File f : files) {
            if (!f.isFile()) {
                continue;
            }
            String n = f.getName().toLowerCase(Locale.US);
            if (!(n.endsWith(".json") || n.endsWith(".txt"))) {
                continue;
            }
            WritableMap m = Arguments.createMap();
            m.putString("name", f.getName());
            m.putString("path", f.getAbsolutePath());
            m.putDouble("size", f.length());
            m.putDouble("mtime", f.lastModified());
            out.pushMap(m);
        }
    }
}
