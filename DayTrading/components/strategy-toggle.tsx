import { Pressable, View, Text, StyleSheet } from 'react-native';

interface Props {
  label: string;
  color: string;
  active: boolean;
  onPress: () => void;
}

export function StrategyToggle({ label, color, active, onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.btn,
        {
          borderColor: active ? color : '#2a2a2a',
          backgroundColor: active ? color + '14' : '#0d0d0d',
        },
        active && {
          shadowColor: color,
          shadowRadius: 6,
          shadowOpacity: 0.45,
          shadowOffset: { width: 0, height: 0 },
        },
        pressed && styles.pressed,
      ]}
    >
      <View
        style={[
          styles.dot,
          { backgroundColor: active ? color : '#333333' },
          active && {
            shadowColor: color,
            shadowRadius: 4,
            shadowOpacity: 0.9,
            shadowOffset: { width: 0, height: 0 },
          },
        ]}
      />
      <Text style={[styles.label, { color: active ? color : '#888888' }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    flex: 1,
  },
  pressed: {
    opacity: 0.75,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
});
