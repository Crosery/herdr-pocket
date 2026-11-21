#import "OrtBridge.h"

#include <vector>

#if __has_include(<onnxruntime/onnxruntime_c_api.h>)
#include <onnxruntime/onnxruntime_c_api.h>
#elif __has_include(<onnxruntime_c_api.h>)
#include <onnxruntime_c_api.h>
#else
#include "onnxruntime_c_api.h"
#endif

static NSString * const kOrtBridgeErrorDomain = @"PocketNative.ONNXRuntime";

static const OrtApi *Ort(void) {
  return OrtGetApiBase()->GetApi(ORT_API_VERSION);
}

static BOOL CheckOrtStatus(const OrtApi *api, OrtStatus *status, NSError **error) {
  if (status == nullptr) {
    return YES;
  }
  const char *msg = api->GetErrorMessage(status);
  NSString *text = msg ? [NSString stringWithUTF8String:msg] : @"ONNX Runtime error";
  int code = static_cast<int>(api->GetErrorCode(status));
  api->ReleaseStatus(status);
  if (error) {
    *error = [NSError errorWithDomain:kOrtBridgeErrorDomain
                                 code:code
                             userInfo:@{NSLocalizedDescriptionKey: text ?: @"ONNX Runtime error"}];
  }
  return NO;
}

static void SetBridgeError(NSError **error, int code, NSString *message) {
  if (error) {
    *error = [NSError errorWithDomain:kOrtBridgeErrorDomain
                                 code:code
                             userInfo:@{NSLocalizedDescriptionKey: message}];
  }
}

static ONNXTensorElementDataType MapTensorElementType(ORTTensorElementDataType t) {
  switch (t) {
    case ORTTensorElementDataTypeFloat: return ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT;
    case ORTTensorElementDataTypeUInt8: return ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT8;
    case ORTTensorElementDataTypeInt8: return ONNX_TENSOR_ELEMENT_DATA_TYPE_INT8;
    case ORTTensorElementDataTypeUInt16: return ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT16;
    case ORTTensorElementDataTypeInt16: return ONNX_TENSOR_ELEMENT_DATA_TYPE_INT16;
    case ORTTensorElementDataTypeInt32: return ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32;
    case ORTTensorElementDataTypeInt64: return ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64;
    case ORTTensorElementDataTypeBool: return ONNX_TENSOR_ELEMENT_DATA_TYPE_BOOL;
    case ORTTensorElementDataTypeFloat16: return ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16;
    case ORTTensorElementDataTypeDouble: return ONNX_TENSOR_ELEMENT_DATA_TYPE_DOUBLE;
    case ORTTensorElementDataTypeUInt32: return ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT32;
    case ORTTensorElementDataTypeUInt64: return ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT64;
    default: return ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED;
  }
}

static size_t ElementByteWidth(ONNXTensorElementDataType t) {
  switch (t) {
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT:
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32:
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT32:
      return 4;
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_DOUBLE:
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64:
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT64:
      return 8;
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16:
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_BFLOAT16:
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT16:
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT16:
      return 2;
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT8:
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT8:
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_BOOL:
      return 1;
    default:
      return 0;
  }
}

@interface ORTEnv () {
@public
  OrtEnv *_env;
}
@end

@implementation ORTEnv
- (nullable instancetype)initWithLoggingLevel:(ORTLoggingLevel)loggingLevel
                                        error:(NSError * _Nullable * _Nullable)error {
  self = [super init];
  if (!self) return nil;
  const OrtApi *api = Ort();
  if (!api) {
    SetBridgeError(error, -1, @"ONNX Runtime C API unavailable");
    return nil;
  }
  OrtLoggingLevel level = static_cast<OrtLoggingLevel>(loggingLevel);
  if (!CheckOrtStatus(api, api->CreateEnv(level, "PocketVoice", &_env), error)) {
    return nil;
  }
  return self;
}

- (void)dealloc {
  if (_env) {
    const OrtApi *api = Ort();
    if (api) api->ReleaseEnv(_env);
    _env = nullptr;
  }
}
@end

@interface ORTSessionOptions () {
@public
  OrtSessionOptions *_options;
}
@end

@implementation ORTSessionOptions
+ (nullable instancetype)createWithError:(NSError * _Nullable * _Nullable)error {
  return [[self alloc] initWithError:error];
}

- (nullable instancetype)initWithError:(NSError * _Nullable * _Nullable)error {
  self = [super init];
  if (!self) return nil;
  const OrtApi *api = Ort();
  if (!api) {
    SetBridgeError(error, -1, @"ONNX Runtime C API unavailable");
    return nil;
  }
  if (!CheckOrtStatus(api, api->CreateSessionOptions(&_options), error)) {
    return nil;
  }
  return self;
}

- (BOOL)setIntraOpNumThreads:(int32_t)intraOpNumThreads
                       error:(NSError * _Nullable * _Nullable)error {
  const OrtApi *api = Ort();
  return CheckOrtStatus(api, api->SetIntraOpNumThreads(_options, intraOpNumThreads), error);
}

- (BOOL)setGraphOptimizationLevel:(ORTGraphOptimizationLevel)graphOptimizationLevel
                            error:(NSError * _Nullable * _Nullable)error {
  const OrtApi *api = Ort();
  GraphOptimizationLevel lvl = static_cast<GraphOptimizationLevel>(graphOptimizationLevel);
  return CheckOrtStatus(api, api->SetSessionGraphOptimizationLevel(_options, lvl), error);
}

- (BOOL)addConfigEntryWithKey:(NSString *)key
                        value:(NSString *)value
                        error:(NSError * _Nullable * _Nullable)error {
  const OrtApi *api = Ort();
  return CheckOrtStatus(api, api->AddSessionConfigEntry(_options, key.UTF8String, value.UTF8String), error);
}

- (void)dealloc {
  if (_options) {
    const OrtApi *api = Ort();
    if (api) api->ReleaseSessionOptions(_options);
    _options = nullptr;
  }
}
@end

@implementation ORTRunOptions
@end

@interface ORTValue () {
@public
  OrtValue *_value;
}
@property (nonatomic, strong, nullable) NSMutableData *backingData;
- (instancetype)initWithOwnedValue:(OrtValue *)ownedValue;
@end

@implementation ORTValue
- (instancetype)initWithOwnedValue:(OrtValue *)ownedValue {
  self = [super init];
  if (self) {
    _value = ownedValue;
  }
  return self;
}

- (nullable instancetype)initWithTensorData:(NSMutableData *)tensorData
                                elementType:(ORTTensorElementDataType)elementType
                                      shape:(NSArray<NSNumber *> *)shape
                                      error:(NSError * _Nullable * _Nullable)error {
  self = [super init];
  if (!self) return nil;
  const OrtApi *api = Ort();
  if (!api) {
    SetBridgeError(error, -1, @"ONNX Runtime C API unavailable");
    return nil;
  }
  ONNXTensorElementDataType cType = MapTensorElementType(elementType);
  if (cType == ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED) {
    SetBridgeError(error, -2, @"Unsupported tensor element type");
    return nil;
  }
  OrtMemoryInfo *memInfo = nullptr;
  if (!CheckOrtStatus(api, api->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &memInfo), error)) {
    return nil;
  }
  std::vector<int64_t> dims;
  dims.reserve(shape.count);
  for (NSNumber *n in shape) {
    dims.push_back(n.longLongValue);
  }
  // Keep a mutable copy retained for the lifetime of this ORTValue.
  NSMutableData *retained = tensorData;
  OrtValue *val = nullptr;
  OrtStatus *st = api->CreateTensorWithDataAsOrtValue(
      memInfo,
      retained.mutableBytes,
      retained.length,
      dims.data(),
      dims.size(),
      cType,
      &val);
  api->ReleaseMemoryInfo(memInfo);
  if (!CheckOrtStatus(api, st, error)) {
    return nil;
  }
  _backingData = retained;
  _value = val;
  return self;
}

- (nullable NSMutableData *)tensorDataWithError:(NSError * _Nullable * _Nullable)error {
  const OrtApi *api = Ort();
  if (!_value || !api) {
    SetBridgeError(error, -3, @"ORTValue is empty");
    return nil;
  }
  OrtTensorTypeAndShapeInfo *info = nullptr;
  if (!CheckOrtStatus(api, api->GetTensorTypeAndShape(_value, &info), error)) {
    return nil;
  }
  ONNXTensorElementDataType cType = ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED;
  size_t elemCount = 0;
  OrtStatus *stType = api->GetTensorElementType(info, &cType);
  OrtStatus *stCount = stType == nullptr ? api->GetTensorShapeElementCount(info, &elemCount) : nullptr;
  api->ReleaseTensorTypeAndShapeInfo(info);
  if (!CheckOrtStatus(api, stType, error) || !CheckOrtStatus(api, stCount, error)) {
    return nil;
  }
  size_t width = ElementByteWidth(cType);
  if (width == 0) {
    SetBridgeError(error, -4, @"Unsupported output tensor element type");
    return nil;
  }
  size_t byteLen = elemCount * width;
  if (byteLen == 0) {
    return [NSMutableData data];
  }
  void *rawData = nullptr;
  if (!CheckOrtStatus(api, api->GetTensorMutableData(_value, &rawData), error)) {
    return nil;
  }
  return [NSMutableData dataWithBytes:rawData length:byteLen];
}

- (void)dealloc {
  if (_value) {
    const OrtApi *api = Ort();
    if (api) api->ReleaseValue(_value);
    _value = nullptr;
  }
}
@end

@interface ORTSession () {
  OrtSession *_session;
}
@property (nonatomic, strong) ORTEnv *retainedEnv;
@end

@implementation ORTSession
- (nullable instancetype)initWithEnv:(ORTEnv *)env
                           modelPath:(NSString *)modelPath
                      sessionOptions:(nullable ORTSessionOptions *)sessionOptions
                               error:(NSError * _Nullable * _Nullable)error {
  self = [super init];
  if (!self) return nil;
  const OrtApi *api = Ort();
  if (!api) {
    SetBridgeError(error, -1, @"ONNX Runtime C API unavailable");
    return nil;
  }
  OrtSessionOptions *defaultOpts = nullptr;
  const OrtSessionOptions *useOpts = sessionOptions ? sessionOptions->_options : nullptr;
  if (!useOpts) {
    if (!CheckOrtStatus(api, api->CreateSessionOptions(&defaultOpts), error)) {
      return nil;
    }
    useOpts = defaultOpts;
  }
  OrtStatus *st = api->CreateSession(env->_env, modelPath.UTF8String, useOpts, &_session);
  if (defaultOpts) api->ReleaseSessionOptions(defaultOpts);
  if (!CheckOrtStatus(api, st, error)) {
    return nil;
  }
  _retainedEnv = env;
  return self;
}

- (nullable NSArray<NSString *> *)inputNamesWithError:(NSError * _Nullable * _Nullable)error {
  const OrtApi *api = Ort();
  OrtAllocator *allocator = nullptr;
  if (!CheckOrtStatus(api, api->GetAllocatorWithDefaultOptions(&allocator), error)) {
    return nil;
  }
  size_t count = 0;
  if (!CheckOrtStatus(api, api->SessionGetInputCount(_session, &count), error)) {
    return nil;
  }
  NSMutableArray<NSString *> *names = [NSMutableArray arrayWithCapacity:count];
  for (size_t i = 0; i < count; i++) {
    char *rawName = nullptr;
    if (!CheckOrtStatus(api, api->SessionGetInputName(_session, i, allocator, &rawName), error)) {
      return nil;
    }
    NSString *str = rawName ? [NSString stringWithUTF8String:rawName] : @"";
    if (rawName) (void)api->AllocatorFree(allocator, rawName);
    [names addObject:str ?: @""];
  }
  return names;
}

- (nullable NSArray<NSString *> *)outputNamesWithError:(NSError * _Nullable * _Nullable)error {
  const OrtApi *api = Ort();
  OrtAllocator *allocator = nullptr;
  if (!CheckOrtStatus(api, api->GetAllocatorWithDefaultOptions(&allocator), error)) {
    return nil;
  }
  size_t count = 0;
  if (!CheckOrtStatus(api, api->SessionGetOutputCount(_session, &count), error)) {
    return nil;
  }
  NSMutableArray<NSString *> *names = [NSMutableArray arrayWithCapacity:count];
  for (size_t i = 0; i < count; i++) {
    char *rawName = nullptr;
    if (!CheckOrtStatus(api, api->SessionGetOutputName(_session, i, allocator, &rawName), error)) {
      return nil;
    }
    NSString *str = rawName ? [NSString stringWithUTF8String:rawName] : @"";
    if (rawName) (void)api->AllocatorFree(allocator, rawName);
    [names addObject:str ?: @""];
  }
  return names;
}

- (nullable NSDictionary<NSString *, ORTValue *> *)runWithInputs:(NSDictionary<NSString *, ORTValue *> *)inputs
                                                     outputNames:(NSSet<NSString *> *)outputNames
                                                      runOptions:(nullable ORTRunOptions *)runOptions
                                                           error:(NSError * _Nullable * _Nullable)error {
  (void)runOptions;
  const OrtApi *api = Ort();
  std::vector<const char *> inNames;
  std::vector<const OrtValue *> inVals;
  std::vector<ORTValue *> keptInputs;
  inNames.reserve(inputs.count);
  inVals.reserve(inputs.count);
  keptInputs.reserve(inputs.count);
  for (NSString *key in inputs) {
    ORTValue *val = inputs[key];
    inNames.push_back(key.UTF8String);
    inVals.push_back(val->_value);
    keptInputs.push_back(val);
  }

  NSArray<NSString *> *outNameList = outputNames.allObjects;
  std::vector<const char *> outNamesC;
  outNamesC.reserve(outNameList.count);
  for (NSString *name in outNameList) {
    outNamesC.push_back(name.UTF8String);
  }
  std::vector<OrtValue *> outVals(outNamesC.size(), nullptr);

  OrtStatus *st = api->Run(
      _session,
      nullptr,
      inNames.data(),
      inVals.data(),
      inNames.size(),
      outNamesC.data(),
      outNamesC.size(),
      outVals.data());
  if (!CheckOrtStatus(api, st, error)) {
    for (OrtValue *v : outVals) {
      if (v) api->ReleaseValue(v);
    }
    return nil;
  }

  NSMutableDictionary<NSString *, ORTValue *> *result = [NSMutableDictionary dictionaryWithCapacity:outNameList.count];
  for (size_t i = 0; i < outNameList.count; i++) {
    if (outVals[i]) {
      result[outNameList[i]] = [[ORTValue alloc] initWithOwnedValue:outVals[i]];
    }
  }
  return result;
}

- (void)dealloc {
  if (_session) {
    const OrtApi *api = Ort();
    if (api) api->ReleaseSession(_session);
    _session = nullptr;
  }
}
@end
