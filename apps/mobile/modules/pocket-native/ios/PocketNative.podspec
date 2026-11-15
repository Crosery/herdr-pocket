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

  s.frameworks = 'AVFoundation', 'PhotosUI', 'UserNotifications', 'Network'
  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
