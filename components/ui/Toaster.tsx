// /src/components/Toaster.tsx

import ToastManager from '@/utils/toast';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';

const TOAST_TIMEOUT = 5000;

export function Toaster() {
  const [toast, setToast] = useState<{ message: string; isVisible: boolean }>({
    message: '',
    isVisible: false
  });
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const unsubscribe = ToastManager.subscribe(({ message }) => {
      setToast({ message, isVisible: true });
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!toast.isVisible) return;

    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 500,
      useNativeDriver: true
    }).start();

    const timer = setTimeout(() => {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 500,
        useNativeDriver: true
      }).start(() => {
        setToast(prev => ({ ...prev, isVisible: false }));
      });
    }, TOAST_TIMEOUT);

    return () => clearTimeout(timer);
  }, [toast.isVisible]);

  if (!toast.isVisible) return null;

  return (
    <Animated.View
      style={[
        styles.container,
        { opacity: fadeAnim }
      ]}
    >
      <Text style={styles.text}>{toast.message}</Text>
    </Animated.View>
  );
}

// 디자인을 커스터마이징 하시려면 여기 CSS 를 수정하시면 됩니다.
const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 50,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  text: {
    color: 'white',
    fontSize: 16,
    fontWeight: 'bold',
    textAlign: 'center',
  },
});