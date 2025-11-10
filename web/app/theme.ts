import { extendTheme, ThemeConfig } from '@chakra-ui/react';

const config: ThemeConfig = {
  initialColorMode: 'dark',
  useSystemColorMode: false
};

const styles = {
  global: {
    'html, body': {
      background: 'radial-gradient(circle at top, rgba(53, 202, 255, 0.12), rgba(10, 10, 26, 1) 55%)',
      color: 'white',
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
    50: '#E8F9FF',
    100: '#BDEEFF',
    200: '#92E3FF',
    300: '#66D8FF',
    400: '#3BCDFF',
    500: '#12B4F6',
    600: '#0C8DC3',
    700: '#066591',
    800: '#023E60',
    900: '#00172F'
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
        bgGradient: 'linear(to-r, brand.400, brand.600)',
        color: 'black',
        boxShadow: '0 0 20px rgba(59, 205, 255, 0.45)',
        _hover: {
          boxShadow: '0 0 30px rgba(59, 205, 255, 0.65)',
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
      bg: 'rgba(13, 18, 34, 0.75)',
      backdropFilter: 'blur(18px)',
      border: '1px solid rgba(59,205,255,0.15)',
      boxShadow: '0 0 30px rgba(2, 62, 96, 0.45)',
      rounded: '2xl'
    }
  }
};

export const theme = extendTheme({ config, styles, colors, fonts, components });
