#include "UPASMDLL.h"

napi_value Init(napi_env env, napi_value exports) {
  return UPASMDLL::Init(env, exports);
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
