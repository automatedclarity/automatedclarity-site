import Head from 'next/head';
import { motion } from 'framer-motion';

export default function Home() {
  return (
    <>
      <Head>
        <title>Automated Clarity | The ACX System</title>
        <meta
          name="description"
          content="Automated Clarity powers the ACX System — a premium done-for-you automation platform for scaling businesses."
        />
      </Head>
      <main className="flex flex-col min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 text-gray-900 relative overflow-hidden">
        {/* Floating gradient shapes */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <motion.div animate={{ y: [0, 30, 0] }} transition={{ repeat: Infinity, duration: 12 }} className="absolute w-72 h-72 bg-purple-400 opacity-20 rounded-full -top-24 -left-24 blur-3xl"></motion.div>
          <motion.div animate={{ y: [0, -40, 0] }} transition={{ repeat: Infinity, duration: 14 }} className="absolute w-96 h-96 bg-blue-400 opacity-20 rounded-full top-1/3 -right-48 blur-3xl"></motion.div>
        </div>

        {/* Hero section with gradient background */}
        <section
          className="relative flex flex-col items-center justify-center text-center py-40 px-6 bg-gradient-to-b from-blue-600 via-purple-700 to-indigo-900 text-white overflow-hidden"
        >
          <motion.h1 initial={{ opacity: 0, y: -50 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1 }} className="relative text-6xl md:text-7xl font-extrabold mb-6 tracking-tight drop-shadow-2xl">
            The ACX System
          </motion.h1>
          <motion.p initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1.3, delay: 0.3 }} className="relative text-xl max-w-3xl mb-12 opacity-90 leading-relaxed">
            Experience automation at a new level — the ACX SaaS engine scales your marketing, engagement, and growth without the complexity.
          </motion.p>
          <motion.a href="#contact" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.6, delay: 0.6 }} className="relative px-12 py-5 bg-gradient-to-r from-blue-500 to-purple-500 hover:from-purple-500 hover:to-blue-500 text-white text-xl font-bold rounded-3xl shadow-2xl transition-transform transform hover:scale-110">
            Request a Demo
          </motion.a>
        </section>

        {/* About section */}
        <motion.section initial={{ opacity: 0, y: 60 }} whileInView={{ opacity: 1, y: 0 }} transition={{ duration: 1 }} className="max-w-5xl mx-auto py-24 px-6 text-center relative z-10">
          <h2 className="text-5xl font-bold mb-8 bg-gradient-to-r from-blue-500 to-purple-500 bg-clip-text text-transparent">Who We Are</h2>
          <p className="text-xl leading-relaxed max-w-3xl mx-auto text-gray-700">
            Automated Clarity, powered by <strong>Duzzi Technologies Inc.</strong>, delivers enterprise-grade automation solutions for high-growth businesses. The ACX platform removes complexity so you can scale effortlessly.
          </p>
        </motion.section>

        {/* Features section */}
        <section className="bg-gradient-to-b from-white to-gray-50 py-24 px-6 text-center relative z-10">
          <h3 className="text-4xl font-bold mb-12">Why Businesses Trust ACX</h3>
          <div className="grid md:grid-cols-3 gap-12 max-w-6xl mx-auto text-gray-800">
            {[
              { title: 'Done-For-You Automation', text: 'We build, optimize, and run your systems so you can scale stress-free.' },
              { title: 'Enterprise SaaS Infrastructure', text: 'Blazing-fast, secure, and scalable — built for serious growth.' },
              { title: 'Freedom from Complexity', text: 'ACX frees your time, replacing complexity with clarity and profit.' }
            ].map((feature, idx) => (
              <motion.div key={idx} initial={{ opacity: 0, y: 40 }} whileInView={{ opacity: 1, y: 0 }} whileHover={{ scale: 1.1 }} transition={{ duration: 0.6 }} className="p-10 bg-white rounded-3xl shadow-2xl transition-transform transform hover:shadow-3xl border border-gray-100">
                <h4 className="text-2xl font-semibold mb-4 text-gray-900">{feature.title}</h4>
                <p className="text-lg text-gray-600">{feature.text}</p>
              </motion.div>
            ))}
          </div>
        </section>

        {/* Contact section */}
        <motion.section id="contact" initial={{ opacity: 0, y: 60 }} whileInView={{ opacity: 1, y: 0 }} transition={{ duration: 1 }} className="flex flex-col items-center justify-center text-center py-24 px-6 bg-gradient-to-br from-gray-100 to-gray-200 relative z-10">
          <h2 className="text-5xl font-bold mb-6">Connect With ACX</h2>
          <p className="mb-10 max-w-xl text-xl text-gray-700">
            See the ACX System in action. Contact us today and start automating your growth.
          </p>
          <a href="mailto:hello@duzzi.ai" className="px-12 py-5 bg-gradient-to-r from-blue-500 to-purple-500 hover:from-purple-500 hover:to-blue-500 text-white text-xl font-bold rounded-3xl shadow-xl transition-transform transform hover:scale-110">
            Email Our Team
          </a>
        </motion.section>

        {/* Footer */}
        <footer className="text-center text-gray-600 py-10 text-sm bg-gray-50 border-t relative z-10">
          <p>
            Automated Clarity is operated by Duzzi Technologies Inc. | 8350 N CENTRAL EXPY STE 1900 #119, DALLAS TX 75206, UNITED STATES
          </p>
          <p className="mt-4">© {new Date().getFullYear()} Automated Clarity. All rights reserved.</p>
        </footer>
      </main>
    </>
  );
}
