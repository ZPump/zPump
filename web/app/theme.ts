import { extendTheme, ThemeConfig } from '@chakra-ui/react';

const config: ThemeConfig = {
  initialColorMode: 'dark',
  useSystemColorMode: false
};

const styles = {
  global: {
    'html, body': {
      background: 'radial-gradient(circle at 20% 10%, rgba(245, 178, 27, 0.12), rgba(5, 5, 7, 1) 58%)',
      color: '#F6F3EA',
      minHeight: '100%',
      fontFamily: 'var(--font-space-grotesk), sans-serif',
      letterSpacing: '0.02em'
    },
    body: {
      bg: 'transparent'
    }
  }
};

const colors = {
  brand: {
    50: '#FFF6E1',
    100: '#FFE3A4',
    200: '#FFD066',
    300: '#FDBC31',
    400: '#F5B21B',
    500: '#D99208',
    600: '#AC7005',
    700: '#7F5204',
    800: '#513303',
    900: '#221501'
  },
  ink: {
    50: '#F6F3EA',
    100: '#DEDACE',
    200: '#AFACA2',
    300: '#807E77',
    400: '#5B5A55',
    500: '#3E3D39',
    600: '#292824',
    700: '#181816',
    800: '#0F0F0D',
    900: '#070707'
  }
};

const fonts = {
  heading: 'var(--font-space-grotesk), sans-serif',
  body: 'var(--font-space-grotesk), sans-serif'
};

const components = {
  Button: {
    baseStyle: {
      rounded: 'full',
      fontWeight: 'semibold'
    },
    variants: {
      glow: {
        bgGradient: 'linear(to-r, brand.300, brand.500)',
        color: 'ink.900',
        boxShadow: '0 12px 28px rgba(245, 178, 27, 0.35)',
        _hover: {
          boxShadow: '0 18px 36px rgba(245, 178, 27, 0.45)',
          transform: 'translateY(-1px)'
        }
      },
      outline: {
        borderColor: 'whiteAlpha.500',
        color: 'white',
        _hover: {
          borderColor: 'brand.300',
          color: 'brand.200'
        }
      }
    }
  },
  Card: {
    baseStyle: {
      bg: 'rgba(18, 16, 14, 0.78)',
      backdropFilter: 'blur(18px)',
      border: '1px solid rgba(245, 178, 27, 0.12)',
      boxShadow: '0 0 30px rgba(12, 10, 6, 0.55)',
      rounded: '2xl'
    }
  }
};

export const theme = extendTheme({ config, styles, colors, fonts, components });
