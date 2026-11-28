#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(int32_t, ORTLoggingLevel) {
  ORTLoggingLevelVerbose = 0,
  ORTLoggingLevelInfo = 1,
  ORTLoggingLevelWarning = 2,
  ORTLoggingLevelError = 3,
  ORTLoggingLevelFatal = 4,
};

typedef NS_ENUM(int32_t, ORTGraphOptimizationLevel) {
  ORTGraphOptimizationLevelDisabled = 0,
  ORTGraphOptimizationLevelBasic = 1,
  ORTGraphOptimizationLevelExtended = 2,
  ORTGraphOptimizationLevelAll = 99,
};

typedef NS_ENUM(int32_t, ORTTensorElementDataType) {
  ORTTensorElementDataTypeUndefined = 0,
  ORTTensorElementDataTypeFloat = 1,
  ORTTensorElementDataTypeUInt8 = 2,
  ORTTensorElementDataTypeInt8 = 3,
  ORTTensorElementDataTypeUInt16 = 4,
  ORTTensorElementDataTypeInt16 = 5,
  ORTTensorElementDataTypeInt32 = 6,
  ORTTensorElementDataTypeInt64 = 7,
  ORTTensorElementDataTypeString = 8,
  ORTTensorElementDataTypeBool = 9,
  ORTTensorElementDataTypeFloat16 = 10,
  ORTTensorElementDataTypeDouble = 11,
  ORTTensorElementDataTypeUInt32 = 12,
  ORTTensorElementDataTypeUInt64 = 13,
};

@interface ORTEnv : NSObject
- (instancetype)init NS_UNAVAILABLE;
- (nullable instancetype)initWithLoggingLevel:(ORTLoggingLevel)loggingLevel
                                        error:(NSError * _Nullable * _Nullable)error;
@end

@interface ORTSessionOptions : NSObject
- (instancetype)init NS_UNAVAILABLE;
- (nullable instancetype)initWithError:(NSError * _Nullable * _Nullable)error NS_DESIGNATED_INITIALIZER;
+ (nullable instancetype)createWithError:(NSError * _Nullable * _Nullable)error;
- (BOOL)setIntraOpNumThreads:(int32_t)intraOpNumThreads
                       error:(NSError * _Nullable * _Nullable)error;
- (BOOL)setGraphOptimizationLevel:(ORTGraphOptimizationLevel)graphOptimizationLevel
                            error:(NSError * _Nullable * _Nullable)error;
- (BOOL)addConfigEntryWithKey:(NSString *)key
                        value:(NSString *)value
                        error:(NSError * _Nullable * _Nullable)error;
@end

@interface ORTRunOptions : NSObject
@end

@interface ORTValue : NSObject
- (instancetype)init NS_UNAVAILABLE;
- (nullable instancetype)initWithTensorData:(NSMutableData *)tensorData
                                elementType:(ORTTensorElementDataType)elementType
                                      shape:(NSArray<NSNumber *> *)shape
                                      error:(NSError * _Nullable * _Nullable)error;
- (nullable NSMutableData *)tensorDataWithError:(NSError * _Nullable * _Nullable)error;
@end

@interface ORTSession : NSObject
@property (nonatomic, readonly) BOOL usingCoreML;
- (instancetype)init NS_UNAVAILABLE;
- (nullable instancetype)initWithEnv:(ORTEnv *)env
                           modelPath:(NSString *)modelPath
                      sessionOptions:(nullable ORTSessionOptions *)sessionOptions
                               error:(NSError * _Nullable * _Nullable)error;
- (nullable instancetype)initWithEnv:(ORTEnv *)env
                           modelPath:(NSString *)modelPath
                      sessionOptions:(nullable ORTSessionOptions *)sessionOptions
                        preferCoreML:(BOOL)preferCoreML
                               error:(NSError * _Nullable * _Nullable)error;
- (nullable NSArray<NSString *> *)inputNamesWithError:(NSError * _Nullable * _Nullable)error;
- (nullable NSArray<NSString *> *)outputNamesWithError:(NSError * _Nullable * _Nullable)error;
- (nullable NSDictionary<NSString *, ORTValue *> *)runWithInputs:(NSDictionary<NSString *, ORTValue *> *)inputs
                                                     outputNames:(NSSet<NSString *> *)outputNames
                                                      runOptions:(nullable ORTRunOptions *)runOptions
                                                           error:(NSError * _Nullable * _Nullable)error;
@end

NS_ASSUME_NONNULL_END
