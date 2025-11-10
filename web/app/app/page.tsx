import { CTA } from '../components/sections/CTA';
import { Features } from '../components/sections/Features';
import { Hero } from '../components/sections/Hero';
import { Footer } from '../components/Footer';
import { Header } from '../components/Header';

export default function HomePage() {
  return (
    <main>
      <Header />
      <Hero />
      <Features />
      <CTA />
      <Footer />
    </main>
  );
}
