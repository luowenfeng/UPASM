#ifndef __UPASM_DLL_H__
#define __UPASM_DLL_H__

#include <node_api.h>

class UPASMDLL {
public:
	static napi_value Init(napi_env env, napi_value exports);
	static void Destructor(napi_env env, void* nativeObject, void* finalize_hint);

private:
	explicit UPASMDLL();
	~UPASMDLL();
	static napi_value New(napi_env env, napi_callback_info info);
	static inline napi_value Constructor(napi_env env);

	napi_env env_;
	napi_ref wrapper_;
	void* dll_inst;
};

#endif