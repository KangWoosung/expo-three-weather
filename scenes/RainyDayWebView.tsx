/*
2026-05-08 05:12:29

rainyday.js 를 직접 로드해서 사용하는 방식으로 시도해보자...

npx expo install react-native-webview expo-asset expo-file-system

*/
import { HEADER_HEIGHT } from '@/components/ParallaxScrollView';
import { toast } from '@/utils/toast';
import { headerImageSourceNight } from '@/zustand/useWeatherStore';
import { Asset } from 'expo-asset';
import { File as ExpoFsFile } from 'expo-file-system';
import React, { useEffect, useMemo, useState } from 'react';
import { Dimensions, Image, ImageSourcePropType, Platform, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

const { width } = Dimensions.get('window');
const height = HEADER_HEIGHT;

type RainyDayWebViewProps = {
  backgroundImage: ImageSourcePropType;
}

const testBackground = headerImageSourceNight;

/** LoadDataWithBaseURL 기준 원본과 배경 이미지 출처 정렬 → canvas drawImage 보안 오류 완화 */
function webViewBaseUrlFromImageUri(uri: string): string {
  if (/^https?:\/\//i.test(uri)) {
    try {
      return `${new URL(uri).origin}/`
    } catch {
      /* noop */
    }
  }
  if (uri.startsWith('file://')) {
    const i = uri.lastIndexOf('/')
    if (i > 'file://'.length) return uri.slice(0, i + 1)
  }
  return ''
}

/** 인라인 클래스 스크립트에서는 `export default` 가 SyntaxError → 라이브러리 전체가 실행되지 않음 */
function stripExportForClassicScript(js: string): string {
  return js.replace(/\bexport\s+default\s+RainyDay\b\s*;?/gm, '').trimEnd();
}

const RainyDayWebView = ({ backgroundImage }: RainyDayWebViewProps) => {
  const [libraryCode, setLibraryCode] = useState('');
  const imageUri = useMemo(() => {
    if (backgroundImage == null) return undefined;
    // 비오는 날은 야간 배경으로 강제 설정
    const resolved = Image.resolveAssetSource(testBackground);
    // const resolved = Image.resolveAssetSource(backgroundImage);
    return resolved?.uri;
  }, [backgroundImage]);

  useEffect(() => {
    // 1. 로컬에 저장된 rainyday.js 파일을 문자열로 읽어옵니다.
    toast.show('RainyDayWebView: loading library...');
    const loadLibrary = async () => {
      try {
        // Metro는 `.js`를 번들에 합쳐 넣어서 Asset.loadAsync에 쓸 실제 파일 URI가 없음.
        // Metro 기본 assetExts에 포함된 `.html`로 복사본을 두고 에셋으로 require (utils/rainyday.js 수정 시 동기화).
        const asset = require('@/assets/vendor/rainyday-webview.html');
        const [{ localUri }] = await Asset.loadAsync(asset);
        if (!localUri) throw new Error('rainyday.js: missing localUri');
        const code = stripExportForClassicScript(await new ExpoFsFile(localUri).text());
        setLibraryCode(code);
        toast.show('RainyDayWebView: library loaded');
      } catch (e) {
        console.error("라이브러리 로드 실패:", e);
      }
    };
    loadLibrary();
  }, []);

  if (!imageUri) {
    console.warn('RainyDayWebView: no image URI for backgroundImage; check source / require()');
    return null;
  }

  if (!libraryCode) return null;

  const htmlContent = `
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <style>
          html, body { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; background: black; }
          /* body.clientWidth/Height → RainyDay 캔버스 크기; % 높이는 부모 높이 없으면 0 */
          #background { width: 100%; height: 100%; object-fit: cover; display: block; }
        </style>
      </head>
      <body>
        <img id="background" crossorigin="anonymous" src=${JSON.stringify(imageUri)} />
        <script>
          ${libraryCode}
          (function patchRainyDayWebViewHooks() {
            RainyDay.prototype.prepareGlass = function () {
              this.glass = document.createElement("canvas");
              this.glass.width = this.canvas.width;
              this.glass.height = this.canvas.height;
              this.context = this.glass.getContext("2d");
              try {
                if ("filter" in this.context) {
                  this.context.filter = "blur(1.5px)";
                }
              } catch (e) {
                console.warn("RainyDay prepareGlass: filter unsupported", e);
              }
            };
          })();
          (function startRain() {
            function boot() {
              var img = document.getElementById('background');
              if (!img) return;
              if (typeof RainyDay !== 'function') {
                console.error('RainyDay is not defined (script parse failed?)');
                return;
              }
              var w = Math.max(1, window.innerWidth || document.documentElement.clientWidth || img.naturalWidth);
              var h = Math.max(1, window.innerHeight || document.documentElement.clientHeight || img.naturalHeight);
              try {
                var engine = new RainyDay({
                  image: img,
                  blur: 10,
                  width: w,
                  height: h,
                  parentElement: document.body,
                });
                /* initialize() 안에서 이미 this.rain([[3,5,0.5]], 50) 호출됨. rain() 재호출은 rAF 중복이라 생략 */
              } catch (e) {
                console.error('RainyDay boot failed:', e);
              }
            }
            var img = document.getElementById('background');
            if (!img) return;
            if (img.complete && img.naturalWidth > 0) {
              boot();
            } else {
              img.onload = function () { boot(); };
              img.onerror = function () {
                console.error('RainyDayWebView: background image failed to load', img.src);
              };
            }
          })();
        </script>
      </body>
    </html>
  `;



  return (
    <View style={styles.container}>
      <WebView
        originWhitelist={['*']}
        source={{ html: htmlContent, baseUrl: webViewBaseUrlFromImageUri(imageUri) }}
        style={styles.webview}
        scrollEnabled={false}
        {...(Platform.OS === 'android' ? { mixedContentMode: 'always' as const } : {})}
        javaScriptEnabled
        domStorageEnabled
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width,
    height,
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    overflow: 'hidden',
  },
  webview: { flex: 1, backgroundColor: 'transparent' },
});

export default RainyDayWebView;

