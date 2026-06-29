# EZHW

## Overview

EZHW is a full-stack web application designed to provide AI-powered assistance for various homework types, including text, image, PDF, and document inputs. It utilizes multiple Large Language Models (LLMs) to generate comprehensive answers, offering features like drag-and-drop file uploads, voice input, mathematical notation rendering, and PDF export. The project's core purpose is to be a user-friendly and comprehensive academic assistance tool for students and educators.

## User Preferences

Preferred communication style: Simple, everyday language.

### Testing Mode Active
**PAYWALL DISABLED FOR TESTING**
- All new users automatically receive 99,999,999 tokens (unlimited credits)
- Token balance checks are disabled - no payment required
- Token deduction is disabled - usage doesn't consume credits
- Payment gateways (PayPal/Stripe) remain functional but not required for testing
- Special users (jmkuczynski, randyjohnson) retain unlimited access with no password

## System Architecture

The application operates on a client-server architecture.

### Frontend
- **Framework**: React 18 with TypeScript and Vite
- **UI/Styling**: Shadcn/ui (Radix UI) and Tailwind CSS
- **State Management**: TanStack Query
- **Routing**: Wouter
- **Display**: MathJax for mathematical notation and integrated image display.

### Backend
- **Runtime**: Node.js with Express.js (TypeScript)
- **Database**: PostgreSQL with Drizzle ORM.
- **File Processing**: Multer for uploads, Tesseract.js for OCR, pdf2json for PDF text extraction.
- **Graph Generation**: Chart.js with ChartJSNodeCanvas for server-side graph creation.

### Core Features & Design Patterns
- **File Processing Pipeline**: Standardized process from upload to LLM processing and response generation.
- **Integrated Graph Generation**: Automatic detection and server-side creation of various graph types, embedded into solutions.
- **LLM Integration**: Supports multiple AI providers, allows user selection, and applies intelligent content detection for LaTeX. Incorporates advanced academic rigor standards in system prompts.
- **Automatic Word Count Continuation**: Detects and meets specified word/page count requirements through iterative content generation.
- **Voice Input**: Leverages Browser Web Speech API and Azure Speech Services for real-time transcription.
- **Mathematical Notation**: MathJax integration for LaTeX support and optimized PDF export.
- **Dual Payment System**: Full PayPal and Stripe integration for authentication and flexible payment.
- **Multi-User Data Isolation**: PostgreSQL ensures user-scoped data access and secure deletion, supporting anonymous users.
- **Grading Assistant**: AI-powered grading tool that adheres to user-provided rubrics in various formats. Includes "Coherence Mode" for long assignments with real-time progress and SSE streaming.
- **Anti-Puffery Writing Quality System**: Default output uses a direct, concise writing style with reduced LLM temperature. Includes a conditional "Bad-Writing Mode" that relaxes constraints if explicitly requested by the user.
- **Hard Constraint Enforcement System**: Extracts and validates against non-negotiable rules (invariants) from user prompts, vetoing and regenerating chunks that violate them.
- **Coherent Chunking System**: For documents over 1000 words, a three-pass architecture ensures global coherence: skeleton generation, chunk processing, and a global stitch pass.
- **Ask-a-Philosopher Integration**: Automatically enriches homework responses with philosophical content by integrating with https://analyticphilosophy.net/. Detects philosophical topics and fetches authoritative quotes, passages, and context, with a "KILL SWITCH" to prevent fabrication if the database fails to deliver authentic content.

## External Dependencies

- **Database**: PostgreSQL
- **LLM APIs**: Anthropic, OpenAI, Azure OpenAI, DeepSeek, Perplexity
- **Payment Gateways**: PayPal, Stripe
- **Philosophical Content**: Ask-a-Philosopher API (https://analyticphilosophy.net/)
- **CDN Services**: MathJax, Google Fonts
- **Speech Services**: Azure Cognitive Services