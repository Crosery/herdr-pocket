Pod::Spec.new do |s|
  s.name           = 'PocketNative'
  s.version        = '1.0.0'
  s.summary        = 'Herdr Pocket native side on iOS: voice call audio, notifications, picking pictures'
  s.description    = s.summary
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Herdr Pocket'
  s.homepage       = 'https://github.com/'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'onnxruntime-c', '~> 1.30.0'

  s.frameworks = 'AVFoundation', 'PhotosUI', 'UserNotifications', 'Network'
  s.libraries = 'c++'
  s.source_files = '**/*.{h,m,mm,swift}'
  s.public_header_files = 'OrtBridge.h'
  s.resource_bundles = {
    'PocketNativeVoice' => ['Resources/voice/*.onnx']
  }
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17'
  }
end
