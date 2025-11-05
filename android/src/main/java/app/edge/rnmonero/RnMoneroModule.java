package app.edge.rnmonero;

import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import java.util.HashMap;
import java.util.Map;

public class RnMoneroModule extends ReactContextBaseJavaModule {
  private native String callMoneroJNI(String method, String[] arguments);

  private native String[] getMethodNames();

  static {
    System.loadLibrary("rnmonero");
  }

  public RnMoneroModule(ReactApplicationContext reactContext) {
    super(reactContext);
  }

  @Override
  public Map<String, Object> getConstants() {
    final Map<String, Object> constants = new HashMap<>();
    constants.put("methodNames", getMethodNames());
    constants.put("documentDirectory", getReactApplicationContext().getFilesDir().getAbsolutePath());
    return constants;
  }

  @Override
  public String getName() {
    return "MoneroLwsfModule";
  }

  @ReactMethod
  public void callMonero(String method, ReadableArray arguments, Promise promise) {
    // Re-package the arguments:
    String[] strings = new String[arguments.size()];
    for (int i = 0; i < arguments.size(); ++i) {
      strings[i] = arguments.getString(i);
    }

    try {
      promise.resolve(callMoneroJNI(method, strings));
    } catch (Exception e) {
      promise.reject("MoneroError", e);
    }
  }
}
