package com.journeyapps.barcodescanner;
public class ScanOptions {
  public static final String QR_CODE = "QR_CODE";
  public final ScanOptions setDesiredBarcodeFormats(String... formats) { return this; }
  public final ScanOptions setPrompt(String prompt) { return this; }
  public ScanOptions setBeepEnabled(boolean enabled) { return this; }
  public ScanOptions setOrientationLocked(boolean locked) { return this; }
}
