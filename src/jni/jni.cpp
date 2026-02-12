#include "../monero-wrapper/monero-methods.hpp"

#include <jni.h>
#include <cstring>

// --- Global JVM / module references for event callbacks ---
static JavaVM* g_jvm = nullptr;
static jobject g_moduleRef = nullptr;

static const std::string unpackJstring(JNIEnv *env, jstring s) {
  const char *p = env->GetStringUTFChars(s, 0);
  const std::string out(p);
  env->ReleaseStringUTFChars(s, p);
  return out;
}

extern "C" {

// Called automatically when the shared library is loaded.
// Store the JavaVM pointer so we can attach to the JVM from any thread.
JNIEXPORT jint JNI_OnLoad(JavaVM* vm, void* /*reserved*/) {
  g_jvm = vm;
  return JNI_VERSION_1_6;
}

JNIEXPORT jstring JNICALL
Java_app_edge_rnmonero_RnMoneroModule_callMoneroJNI(
  JNIEnv *env,
  jobject self,
  jstring method,
  jobjectArray arguments
) {
  const std::string methodString = unpackJstring(env, method);

  // Re-package the arguments:
  jsize length = env->GetArrayLength(arguments);
  std::vector<const std::string> strings;
  strings.reserve(length);
  for (jsize i = 0; i < length; ++i) {
    jstring string = (jstring)env->GetObjectArrayElement(arguments, i);
    strings.push_back(unpackJstring(env, string));
  }

  // Find the named method:
  for (int i = 0; i < moneroMethodCount; ++i) {
    if (moneroMethods[i].name != methodString) continue;

    // Validate the argument count (skip if -1 means variable args):
    if (moneroMethods[i].argc != -1 && strings.size() != moneroMethods[i].argc) {
      env->ThrowNew(
        env->FindClass("java/lang/Exception"),
        "lwsf incorrect C++ argument count"
      );
      return nullptr;
    }

    // Call the method, with error handling:
    try {
      const std::string out = moneroMethods[i].method(strings);
      return env->NewStringUTF(out.c_str());
    } catch (std::exception &e) {
      env->ThrowNew(env->FindClass("java/lang/Exception"), e.what());
      return nullptr;
    } catch (...) {
      env->ThrowNew(
        env->FindClass("java/lang/Exception"),
        "lwsf threw a C++ exception"
      );
      return nullptr;
    }
  }

  env->ThrowNew(
    env->FindClass("java/lang/NoSuchMethodException"),
    ("No lwsf C++ method " + methodString).c_str()
  );
  return nullptr;
}

JNIEXPORT jobjectArray JNICALL
Java_app_edge_rnmonero_RnMoneroModule_getMethodNames(
  JNIEnv *env,
  jobject self
) {
  jobjectArray out = env->NewObjectArray(
    moneroMethodCount,
    env->FindClass("java/lang/String"),
    env->NewStringUTF("")
  );
  if (!out) return nullptr;

  for (int i = 0; i < moneroMethodCount; ++i) {
    jstring name = env->NewStringUTF(moneroMethods[i].name);
    env->SetObjectArrayElement(out, i, name);
  }
  return out;
}

// Called from RnMoneroModule constructor to wire the C++ wallet-event
// callback to the Java module's onWalletEvent method.
JNIEXPORT void JNICALL
Java_app_edge_rnmonero_RnMoneroModule_initEventCallback(
  JNIEnv *env,
  jobject self
) {
  // Replace any previous global ref
  if (g_moduleRef != nullptr) {
    env->DeleteGlobalRef(g_moduleRef);
  }
  g_moduleRef = env->NewGlobalRef(self);

  moneroSetEventCallback([](const std::string& walletId,
                            const std::string& eventName,
                            const std::string& jsonPayload) {
    if (g_jvm == nullptr || g_moduleRef == nullptr) return;

    JNIEnv* cbEnv = nullptr;
    bool didAttach = false;
    int status = g_jvm->GetEnv(reinterpret_cast<void**>(&cbEnv), JNI_VERSION_1_6);
    if (status == JNI_EDETACHED) {
      if (g_jvm->AttachCurrentThread(&cbEnv, nullptr) != JNI_OK) return;
      didAttach = true;
    } else if (status != JNI_OK) {
      return;
    }

    jclass cls = cbEnv->GetObjectClass(g_moduleRef);
    jmethodID mid = cbEnv->GetMethodID(
      cls, "onWalletEvent",
      "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V");

    if (mid != nullptr) {
      jstring jWalletId  = cbEnv->NewStringUTF(walletId.c_str());
      jstring jEventName = cbEnv->NewStringUTF(eventName.c_str());
      jstring jPayload   = cbEnv->NewStringUTF(jsonPayload.c_str());
      cbEnv->CallVoidMethod(g_moduleRef, mid, jWalletId, jEventName, jPayload);
      cbEnv->DeleteLocalRef(jWalletId);
      cbEnv->DeleteLocalRef(jEventName);
      cbEnv->DeleteLocalRef(jPayload);
    }

    if (didAttach) {
      g_jvm->DetachCurrentThread();
    }
  });
}

}
